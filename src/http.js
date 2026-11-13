'use strict';
const { LIMITS } = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

// # Lee el cuerpo completo; corta la conexión si supera el límite
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, 100_000);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

// # Protección CSRF: toda petición que modifica datos debe traer esta cabecera propia
function requireXHR(req) {
  if (req.headers['x-requested-with'] !== 'sync') throw new HttpError(403, 'csrf');
}

// # IP real del cliente; solo se confía en X-Forwarded-For si viene de un proxy local (nginx)
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  const isLocalProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  return forwarded && isLocalProxy ? String(forwarded).split(',')[0].trim() : remote;
}

// # Límite de peticiones por IP y por "bucket" en ventana de tiempo
const hits = new Map();
function rateLimit(req, bucket, max, windowMs = 60000) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  let hit = hits.get(key);
  if (!hit || hit.reset < now) {
    hit = { count: 0, reset: now + windowMs };
    hits.set(key, hit);
  }
  if (++hit.count > max) throw new HttpError(429, 'demasiadas_peticiones');
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of hits) if (hit.reset < now) hits.delete(key);
}, 60000).unref();

const limitApi = (req) => rateLimit(req, 'api', LIMITS.apiRequestsPerMinute);
const limitAuth = (req) => rateLimit(req, 'auth', LIMITS.authRequestsPerMinute);

module.exports = { HttpError, json, redirect, readBody, readJson, parseCookies, requireXHR, limitApi, limitAuth };

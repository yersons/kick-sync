'use strict';
const http = require('node:http');
const { CFG, LIMITS } = require('./config');
const { db, flush, makeBackup } = require('./db');
const { HttpError, json, requireXHR, limitAuth } = require('./http');
const { login, callback, destroySession } = require('./auth');
const { handleWebhook } = require('./webhook');
const { handleApi } = require('./routes/api');
const { serveStatic } = require('./routes/static');
const { schedule } = require('./playback');
const { changed } = require('./realtime');
const { log } = require('./utils');

const STARTED_AT = Date.now();

const NOT_FOUND_PAGE =
  '<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#0b0d10;color:#eee;padding:3rem">' +
  '<h1>404</h1><p>Canal o página no encontrada.</p><a style="color:#53fc18" href="/">Volver</a>';

// # Reparte cada petición a su manejador según método y ruta
async function route(req, res) {
  const url = new URL(req.url, CFG.baseUrl);
  const { pathname } = url;
  const { method } = req;

  if (pathname === '/healthz') return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - STARTED_AT) / 1000) });
  if (pathname === '/webhooks/kick' && method === 'POST') return handleWebhook(req, res);

  if (pathname === '/auth/kick/login' && method === 'GET') {
    limitAuth(req);
    return login(req, res, url);
  }
  if (pathname === '/auth/kick/callback' && method === 'GET') {
    limitAuth(req);
    return callback(req, res, url);
  }
  if (pathname === '/auth/logout' && method === 'POST') {
    requireXHR(req);
    destroySession(req);
    return json(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method');
  return serveStatic(req, res, pathname);
}

async function onRequest(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (res.headersSent) return res.end();
    const wantsHtml = req.headers.accept?.includes('text/html') && !req.url.startsWith('/api/');
    if (wantsHtml && e.status === 404) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(NOT_FOUND_PAGE);
    }
    json(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'error_interno' });
  }
}

// # Al apagar se guarda la base de datos; ante un error inesperado se guarda y se sale
function installProcessHooks() {
  const saveAndExit = (code) => () => {
    try { flush(); } catch {}
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, saveAndExit(0));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
  process.on('uncaughtException', (e) => {
    console.error('uncaughtException', e);
    saveAndExit(1)();
  });
}

// # Tareas periódicas: peticiones sin revisar caducan y se hace respaldo cada 6 h
function startBackgroundJobs() {
  setInterval(() => {
    const now = Date.now();
    for (const ch of Object.values(db.channels)) {
      const before = ch.pending.length;
      ch.pending = ch.pending.filter((song) => now - song.at < LIMITS.pendingTtlMs);
      if (ch.pending.length !== before) changed(ch);
    }
  }, 600000).unref();

  const backup = () => {
    try { makeBackup(); } catch (e) { log('backup', e.message); }
  };
  backup();
  setInterval(backup, 6 * 3600 * 1000).unref();
}

function logStartup() {
  log(`Kick Sync en ${CFG.host}:${CFG.port}  base=${CFG.baseUrl}`);
  log(`Redirect URI: ${CFG.redirectUri}   Webhook: ${CFG.webhookUrl}`);
  if (!CFG.clientId) log('⚠ Falta KICK_CLIENT_ID / KICK_CLIENT_SECRET');
  if (!CFG.ownerId && !CFG.ownerNames.length) {
    log('ℹ Sin OWNER_ID / OWNER_USERNAME: el panel de dueño (/owner) está desactivado');
  } else {
    log(`Panel de dueño activo en ${CFG.baseUrl}/owner (por ${CFG.ownerId ? 'OWNER_ID' : 'OWNER_USERNAME'})`);
  }
}

function start() {
  installProcessHooks();
  const server = http.createServer(onRequest);
  server.keepAliveTimeout = 70000;
  Object.values(db.channels).forEach(schedule); // reanuda los temporizadores de canciones en curso
  startBackgroundJobs();
  server.listen(CFG.port, CFG.host, logStartup);
  return server;
}

module.exports = { start };

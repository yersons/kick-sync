'use strict';
const crypto = require('node:crypto');
const { HttpError, json, readJson } = require('../http');
const { findBySlug } = require('../channels');
const { clientsOf, publicState, changed, openSSE } = require('../realtime');
const { startNext, schedule } = require('../playback');
const { clamp } = require('../utils');

const ROUTE_RE = /^\/api\/p\/([a-z0-9_-]+)\/(events|state|ended|error|meta)$/;

// # Comparación en tiempo constante para no filtrar la clave por tiempo de respuesta
function validKey(provided, real) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// # Rutas del reproductor: lectura pública y avisos del reproductor de OBS (requieren clave)
async function playerApi(req, res, url) {
  const match = url.pathname.match(ROUTE_RE);
  if (!match) return false;
  const [, slug, route] = match;
  const ch = findBySlug(slug);
  if (!ch || !ch.settings.enabled || ch.suspended) throw new HttpError(404, 'canal_no_encontrado');

  if (route === 'events' && req.method === 'GET') {
    openSSE(req, res, clientsOf(ch.id).pub, res, publicState(ch));
    return true;
  }
  if (route === 'state' && req.method === 'GET') {
    json(res, 200, publicState(ch));
    return true;
  }
  if (req.method !== 'POST') return false;

  const body = await readJson(req);
  if (!validKey(req.headers['x-player-key'] || body.key, ch.playerKey)) throw new HttpError(403, 'clave_invalida');

  // # Los avisos de una canción que ya no suena se ignoran
  const current = ch.playback.song;
  if (!current || current.id !== body.songId) {
    json(res, 200, { ok: true, ignored: true });
    return true;
  }

  if (route === 'ended') {
    startNext(ch);
    changed(ch);
  } else if (route === 'error') {
    startNext(ch, { error: `No se pudo reproducir (código ${clamp(body.code, 0, 999, 0)})` });
    changed(ch);
  } else if (route === 'meta') {
    const duration = clamp(body.duration, 0, 86400, 0);
    if (duration && !current.duration) {
      current.duration = duration;
      schedule(ch);
      changed(ch);
    }
  }
  json(res, 200, { ok: true });
  return true;
}

module.exports = { playerApi };

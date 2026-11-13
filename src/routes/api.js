'use strict';
const { CFG } = require('../config');
const { db, audit } = require('../db');
const { HttpError, json, requireXHR, limitApi } = require('../http');
const { sessionUser, requireUser } = require('../auth');
const { canModerate, isPlatformOwner, resolveSlug } = require('../channels');
const { newChannel } = require('../models');
const { ensureSubscription } = require('../kick');
const { changed } = require('../realtime');
const { channelApi } = require('./channel');
const { playerApi } = require('./player');
const { ownerApi } = require('./owner');

// # Datos de la sesión actual: usuario, canales a los que tiene acceso y avisos globales
function me(req, res) {
  const user = sessionUser(req);
  const globals = { announcement: db.meta.announcement, maintenance: db.meta.maintenance };
  if (!user) return json(res, 200, { user: null, ...globals });

  const channels = Object.values(db.channels)
    .filter((c) => canModerate(user, c))
    .map((c) => ({ id: c.id, slug: c.slug, name: c.name, isOwner: c.id === user.id, suspended: c.suspended }));
  return json(res, 200, {
    user: { id: user.id, name: user.name, picture: user.picture, tokenError: !!user.tokenError },
    channels,
    ownChannel: !!db.channels[user.id],
    isPlatformOwner: isPlatformOwner(user),
    ytSearch: !!CFG.ytKey,
    webhookUrl: CFG.webhookUrl,
    ...globals,
  });
}

// # Crea (si no existe) y activa el canal del usuario, respetando suspensión y registros cerrados
async function activateChannel(req, res) {
  const user = requireUser(req);
  let ch = db.channels[user.id];
  if (ch?.suspended) throw new HttpError(403, 'canal_suspendido');

  const allowed = db.meta.signupsOpen || isPlatformOwner(user) || db.meta.allowList.includes(String(user.name).toLowerCase());
  if (!ch && !allowed) throw new HttpError(403, 'registros_cerrados');
  if (!ch) {
    ch = db.channels[user.id] = newChannel(user, await resolveSlug(user));
    audit(user.name, 'canal_creado', ch.slug);
  }

  ch.settings.enabled = true;
  let warn = null;
  try {
    await ensureSubscription(ch);
  } catch (e) {
    warn = e.message;
  }
  changed(ch);
  return json(res, 200, { ok: true, channelId: ch.id, warn });
}

// # Punto de entrada de /api/*: límite de peticiones, CSRF y reparto por tipo de ruta
async function handleApi(req, res, url) {
  const { pathname } = url;
  if (!pathname.endsWith('/events')) limitApi(req);
  if (req.method !== 'GET') requireXHR(req);

  if (pathname === '/api/me' && req.method === 'GET') return me(req, res);
  if (pathname.startsWith('/api/owner/')) return ownerApi(req, res, url);
  if (pathname === '/api/channel/activate' && req.method === 'POST') return activateChannel(req, res);
  if (await channelApi(req, res, url)) return;
  if (await playerApi(req, res, url)) return;
  throw new HttpError(404, 'not_found');
}

module.exports = { handleApi };

'use strict';
const { db } = require('../db');
const { requireUser } = require('../auth');
const { HttpError, json, readJson } = require('../http');
const { canModerate, isChannelOwner } = require('../channels');
const { ensureSubscription } = require('../kick');
const { clientsOf, dashState, changed, openSSE } = require('../realtime');
const { doAction } = require('../playback');
const { rand, clamp, normalizeNames } = require('../utils');

const ROUTE_RE = /^\/api\/c\/(\d+)\/(events|action|settings|regen-key|resubscribe)$/;

// # Rutas del panel de un canal: mods pueden operar la cola; solo el streamer cambia la configuración
async function channelApi(req, res, url) {
  const match = url.pathname.match(ROUTE_RE);
  if (!match) return false;
  const [, channelId, route] = match;
  const user = requireUser(req);
  const ch = db.channels[channelId];
  if (!ch || !canModerate(user, ch)) throw new HttpError(403, 'sin_permiso');

  if (route === 'events' && req.method === 'GET') {
    openSSE(req, res, clientsOf(ch.id).dash, { res, userId: user.id }, dashState(ch, user));
    return true;
  }
  if (route === 'action' && req.method === 'POST') {
    json(res, 200, await doAction(ch, user, await readJson(req)));
    return true;
  }

  if (!isChannelOwner(user, ch)) throw new HttpError(403, 'solo_streamer');

  if (route === 'settings' && req.method === 'PUT') {
    applySettings(ch.settings, await readJson(req));
    changed(ch);
    json(res, 200, { ok: true });
    return true;
  }
  if (route === 'regen-key' && req.method === 'POST') {
    ch.playerKey = rand(18);
    changed(ch);
    json(res, 200, { ok: true });
    return true;
  }
  if (route === 'resubscribe' && req.method === 'POST') {
    let warn = null;
    try {
      await ensureSubscription(ch);
    } catch (e) {
      warn = e.message;
    }
    changed(ch);
    json(res, 200, { ok: !warn, warn });
    return true;
  }
  return false;
}

// # Valida y aplica la configuración enviada por el streamer
function applySettings(s, body) {
  s.enabled = !!body.enabled;
  s.requireApproval = !!body.requireApproval;
  s.autoApproveMods = !!body.autoApproveMods;
  s.trustBadgeMods = !!body.trustBadgeMods;
  s.chatReplies = !!body.chatReplies;

  const command = String(body.command || '!sr').trim().toLowerCase();
  if (/^!?[a-z0-9_]{1,20}$/.test(command)) s.command = command.startsWith('!') ? command : `!${command}`;

  s.maxPerUser = clamp(body.maxPerUser, 1, 50, s.maxPerUser);
  s.maxQueue = clamp(body.maxQueue, 1, 200, s.maxQueue);
  s.maxDurationMin = clamp(body.maxDurationMin, 0, 600, s.maxDurationMin);
  s.cooldownSec = clamp(body.cooldownSec, 0, 600, s.cooldownSec);
  s.volume = clamp(body.volume, 0, 100, s.volume);
  s.skipVotes = clamp(body.skipVotes, 0, 100, s.skipVotes);
  s.blockedUsers = normalizeNames(body.blockedUsers, 500);
  s.mods = normalizeNames(body.mods, 100);
}

module.exports = { channelApi };

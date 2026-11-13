'use strict';
const { CFG } = require('../config');
const { db, save, audit, makeBackup, listBackups, dbSizeBytes } = require('../db');
const { HttpError, json, readJson } = require('../http');
const { requireUser } = require('../auth');
const { isPlatformOwner } = require('../channels');
const { ensureSubscription, removeSubscription } = require('../kick');
const { changed, disconnectChannel, countConnections } = require('../realtime');
const { schedule, cancelTimer, clearVotes } = require('../playback');
const { rand, normalizeNames } = require('../utils');

const STARTED_AT = Date.now();
const CHANNEL_ROUTE_RE = /^\/api\/owner\/channel\/(\d+)\/(suspend|unsuspend|resubscribe|regen-key|clear|delete|logout)$/;

function overview(user) {
  const channels = Object.values(db.channels);
  const sumStats = (key) => channels.reduce((total, c) => total + c.stats[key], 0);
  return {
    me: { id: user.id, name: user.name },
    server: {
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      node: process.version,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      dbKB: Math.round(dbSizeBytes() / 1024),
      sse: countConnections(),
      baseUrl: CFG.baseUrl,
      ytKey: !!CFG.ytKey,
      ownerBy: CFG.ownerId ? 'OWNER_ID' : 'OWNER_USERNAME',
    },
    totals: {
      users: Object.keys(db.users).length,
      channels: channels.length,
      active: channels.filter((c) => c.settings.enabled && !c.suspended).length,
      suspended: channels.filter((c) => c.suspended).length,
      sessions: Object.keys(db.sessions).length,
      played: sumStats('played'),
      requests: sumStats('requests'),
    },
    meta: { announcement: db.meta.announcement, maintenance: db.meta.maintenance, signupsOpen: db.meta.signupsOpen, allowList: db.meta.allowList },
    channels: channels.sort((a, b) => b.lastActive - a.lastActive).map((c) => ({
      id: c.id, slug: c.slug, name: c.name, enabled: c.settings.enabled, suspended: c.suspended,
      subscribed: !!c.subscriptionId, subError: c.subError, queue: c.queue.length, pending: c.pending.length,
      now: c.playback.song?.title || null, played: c.stats.played, requests: c.stats.requests,
      mods: c.settings.mods.length + Object.keys(c.detectedMods).length,
      createdAt: c.createdAt, lastActive: c.lastActive, tokenError: !!db.users[c.id]?.tokenError,
    })),
    audit: db.meta.audit.slice(0, 40),
    backups: listBackups().slice(0, 10),
  };
}

// # Exportación segura: sin tokens, sesiones ni claves de OBS
function exportData() {
  return {
    exportedAt: new Date().toISOString(),
    meta: db.meta,
    users: Object.values(db.users).map(({ id, name, picture }) => ({ id, name, picture })),
    channels: Object.values(db.channels).map(({ playerKey, ...channel }) => channel),
  };
}

function dropChannel(ch) {
  cancelTimer(ch);
  clearVotes(ch);
  disconnectChannel(ch.id);
  delete db.channels[ch.id];
}

function closeSessionsOf(userId) {
  let closed = 0;
  for (const [key, session] of Object.entries(db.sessions)) {
    if (session.userId !== userId) continue;
    delete db.sessions[key];
    closed++;
  }
  return closed;
}

// # Acciones sobre un canal; cada una devuelve datos extra para la respuesta (o nada)
const CHANNEL_ACTIONS = {
  suspend(ch, who) {
    ch.suspended = true;
    cancelTimer(ch);
    audit(who, 'owner:suspender', ch.slug);
    changed(ch);
  },
  unsuspend(ch, who) {
    ch.suspended = false;
    schedule(ch);
    audit(who, 'owner:reactivar', ch.slug);
    changed(ch);
  },
  'regen-key'(ch, who) {
    ch.playerKey = rand(18);
    audit(who, 'owner:regen-key', ch.slug);
    changed(ch);
  },
  clear(ch, who) {
    ch.pending.length = 0;
    ch.queue.length = 0;
    audit(who, 'owner:vaciar', ch.slug);
    changed(ch);
  },
  logout(ch, who) {
    const closed = closeSessionsOf(ch.id);
    audit(who, 'owner:cerrar-sesiones', `${ch.slug} (${closed})`);
    save();
    return { closed };
  },
  async resubscribe(ch, who) {
    let warn = null;
    try {
      await ensureSubscription(ch);
    } catch (e) {
      warn = e.message;
    }
    audit(who, 'owner:resubscribe', ch.slug);
    changed(ch);
    return { ok: !warn, warn };
  },
  async delete(ch, who) {
    await removeSubscription(ch);
    audit(who, 'owner:eliminar', ch.slug);
    dropChannel(ch);
    save();
  },
};

// # API del dueño de la plataforma: nadie más puede usarla
async function ownerApi(req, res, url) {
  const user = requireUser(req);
  if (!isPlatformOwner(user)) throw new HttpError(403, 'solo_owner');
  const { pathname } = url;
  const { method } = req;

  if (pathname === '/api/owner/overview' && method === 'GET') return json(res, 200, overview(user));

  if (pathname === '/api/owner/settings' && method === 'PUT') {
    const body = await readJson(req);
    db.meta.announcement = String(body.announcement || '').slice(0, 300);
    db.meta.maintenance = !!body.maintenance;
    db.meta.signupsOpen = !!body.signupsOpen;
    db.meta.allowList = normalizeNames(body.allowList, 500);
    audit(user.name, 'owner:ajustes', `mantenimiento=${db.meta.maintenance} registros=${db.meta.signupsOpen}`);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/owner/backup' && method === 'POST') {
    const name = makeBackup();
    audit(user.name, 'owner:backup', name);
    return json(res, 200, { ok: true, name });
  }

  if (pathname === '/api/owner/export' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="kick-sync-export.json"',
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify(exportData(), null, 2));
  }

  const match = pathname.match(CHANNEL_ROUTE_RE);
  if (match && method === 'POST') {
    const ch = db.channels[match[1]];
    if (!ch) throw new HttpError(404, 'canal_no_encontrado');
    const extra = await CHANNEL_ACTIONS[match[2]](ch, user.name);
    return json(res, 200, extra || { ok: true });
  }

  throw new HttpError(404, 'not_found');
}

module.exports = { ownerApi };

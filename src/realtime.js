'use strict';
const { CFG, LIMITS } = require('./config');
const { db, save } = require('./db');
const { canModerate, isChannelOwner, isPlatformOwner } = require('./channels');
const { HttpError } = require('./http');

// # Conexiones SSE abiertas por canal: "pub" (reproductor/OBS) y "dash" (panel de mods)
const clients = new Map();
const clientsOf = (channelId) => {
  if (!clients.has(channelId)) clients.set(channelId, { pub: new Set(), dash: new Set() });
  return clients.get(channelId);
};

// # Versión reducida de una canción para enviar al navegador
const brief = (s) => s && { id: s.id, videoId: s.videoId, title: s.title, channelTitle: s.channelTitle, duration: s.duration, thumb: s.thumb, by: s.by.name };

// # Estado visible para cualquiera con el link público
function publicState(ch) {
  const { playback: pb } = ch;
  return {
    slug: ch.slug,
    name: ch.name,
    enabled: ch.settings.enabled && !ch.suspended,
    volume: ch.settings.volume,
    serverNow: Date.now(),
    playback: { song: brief(pb.song), startedAt: pb.startedAt, paused: pb.paused, pausedPos: pb.pausedPos },
    queue: ch.queue.slice(0, 20).map(brief),
  };
}

// # Estado completo para el panel; la clave de OBS solo se envía al dueño
function dashState(ch, user) {
  const owner = isChannelOwner(user, ch);
  const state = {
    ...publicState(ch),
    pending: ch.pending.map((s) => ({ ...brief(s), at: s.at })),
    queueFull: ch.queue.map(brief),
    history: ch.history.slice(0, 15).map((s) => ({ ...brief(s), playedAt: s.playedAt, error: s.error })),
    isOwner: owner,
    isPlatformOwner: isPlatformOwner(user),
    suspended: ch.suspended,
    stats: ch.stats,
    settings: ch.settings,
    command: ch.settings.command,
    subscribed: !!ch.subscriptionId,
    subError: ch.subError,
    ytSearch: !!CFG.ytKey,
    detectedMods: Object.values(ch.detectedMods),
  };
  if (owner) state.playerKey = ch.playerKey;
  return state;
}

const sseMessage = (payload) => `event: state\ndata: ${JSON.stringify(payload)}\n\n`;

// # Guarda y avisa a todos los conectados del canal; corta a quien ya perdió permisos
function changed(ch) {
  save();
  const group = clients.get(ch.id);
  if (!group) return;
  const publicMsg = sseMessage(publicState(ch));
  for (const res of group.pub) res.write(publicMsg);
  for (const entry of [...group.dash]) {
    const user = db.users[entry.userId];
    if (!canModerate(user, ch)) {
      entry.res.end();
      group.dash.delete(entry);
      continue;
    }
    entry.res.write(sseMessage(dashState(ch, user)));
  }
}

function openSSE(req, res, set, entry, firstState) {
  if (set.size >= LIMITS.maxSseClients) throw new HttpError(503, 'demasiadas_conexiones');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n\n${sseMessage(firstState)}`);
  set.add(entry);
  req.on('close', () => set.delete(entry));
}

// # Cierra todas las conexiones de un canal (al eliminarlo)
function disconnectChannel(channelId) {
  const group = clients.get(channelId);
  if (!group) return;
  for (const res of group.pub) try { res.end(); } catch {}
  for (const entry of group.dash) try { entry.res.end(); } catch {}
  clients.delete(channelId);
}

function countConnections() {
  let total = 0;
  for (const group of clients.values()) total += group.pub.size + group.dash.size;
  return total;
}

// # Comentario SSE cada 20 s para que proxies y navegadores no cierren la conexión
setInterval(() => {
  for (const group of clients.values()) {
    for (const res of group.pub) res.write(': ka\n\n');
    for (const entry of group.dash) entry.res.write(': ka\n\n');
  }
}, 20000).unref();

module.exports = { clientsOf, publicState, dashState, changed, openSSE, disconnectChannel, countConnections };

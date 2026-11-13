'use strict';
const { rand } = require('./utils');

// # Valores por defecto de la configuración de un canal
const defaultSettings = () => ({
  enabled: true,
  command: '!sr',
  requireApproval: true,
  autoApproveMods: true,
  trustBadgeMods: true,
  maxPerUser: 3,
  maxQueue: 50,
  maxDurationMin: 10,
  cooldownSec: 15,
  chatReplies: false,
  mods: [],
  volume: 60,
  skipVotes: 0,
  blockedUsers: [],
});

// # Estado de reproducción sin canción
const idlePlayback = () => ({ song: null, startedAt: 0, paused: false, pausedPos: 0 });

function newChannel(user, slug) {
  const now = Date.now();
  return {
    id: user.id,
    slug,
    name: user.name,
    createdAt: now,
    lastActive: now,
    playerKey: rand(18),
    subscriptionId: null,
    subError: null,
    suspended: false,
    settings: defaultSettings(),
    stats: { played: 0, requests: 0 },
    detectedMods: {},
    pending: [],
    queue: [],
    history: [],
    playback: idlePlayback(),
  };
}

// # Completa los campos que le falten a un canal guardado con una versión antigua
function migrateChannel(ch) {
  ch.settings = Object.assign(defaultSettings(), ch.settings || {});
  ch.stats = Object.assign({ played: 0, requests: 0 }, ch.stats || {});
  ch.suspended = !!ch.suspended;
  ch.lastActive = ch.lastActive || ch.createdAt || 0;
  ch.detectedMods ||= {};
  ch.pending ||= [];
  ch.queue ||= [];
  ch.history ||= [];
}

module.exports = { defaultSettings, idlePlayback, newChannel, migrateChannel };

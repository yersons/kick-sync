'use strict';
const { CFG, KICK } = require('./config');
const { db } = require('./db');
const { kickRequest, ensureToken } = require('./kick');
const { log } = require('./utils');

const findBySlug = (slug) => Object.values(db.channels).find((c) => c.slug === String(slug).toLowerCase());

// # Owner de la plataforma: por ID (recomendado) o, si no hay ID, por nombre de usuario
function isPlatformOwner(user) {
  if (!user) return false;
  if (CFG.ownerId) return user.id === CFG.ownerId;
  return CFG.ownerNames.includes(String(user.name || '').toLowerCase());
}

// # Streamer dueño del canal (el owner de la plataforma cuenta como dueño de todos)
const isChannelOwner = (user, ch) => !!user && !!ch && (user.id === ch.id || isPlatformOwner(user));

// # Quién puede usar el panel: streamer, owner, mods de la lista y mods detectados por insignia
function canModerate(user, ch) {
  if (!user || !ch) return false;
  if (isChannelOwner(user, ch)) return true;
  if (ch.settings.mods.includes(String(user.name || '').toLowerCase())) return true;
  return !!(ch.settings.trustBadgeMods && ch.detectedMods[user.id]);
}

// # Genera un slug único para la URL pública a partir del canal de Kick
async function resolveSlug(user) {
  let slug = '';
  try {
    const res = await kickRequest('GET', `${KICK.api}/channels`, { token: await ensureToken(user) });
    slug = res.data?.data?.[0]?.slug || '';
  } catch (e) {
    log('slug', e.message);
  }
  slug = (slug || user.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `canal-${user.id}`;

  let candidate = slug;
  for (let i = 2; findBySlug(candidate) && findBySlug(candidate).id !== user.id; i++) candidate = `${slug}-${i}`;
  return candidate;
}

module.exports = { findBySlug, isPlatformOwner, isChannelOwner, canModerate, resolveSlug };

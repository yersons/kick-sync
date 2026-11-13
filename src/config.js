'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalizeNames } = require('./utils');

const ROOT = path.join(__dirname, '..');

// # Lee el .env sin dependencias; lo ya definido en el entorno tiene prioridad
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    const quoted = /^(["']).*\1$/.test(raw);
    if (!(key in process.env)) process.env[key] = quoted ? raw.slice(1, -1) : raw;
  }
}
loadEnv(path.join(ROOT, '.env'));

const env = process.env;
const baseUrl = (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// # Configuración leída del entorno (ver .env.example)
const CFG = Object.freeze({
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  baseUrl,
  clientId: env.KICK_CLIENT_ID || '',
  clientSecret: env.KICK_CLIENT_SECRET || '',
  ytKey: env.YOUTUBE_API_KEY || '',
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  backupKeep: Number(env.BACKUP_KEEP || 14),
  ownerId: String(env.OWNER_ID || '').trim(),
  ownerNames: normalizeNames(String(env.OWNER_USERNAME || '').split(',')),
  testPublicKey: env.KICK_PUBLIC_KEY_PEM || '', // solo para las pruebas
  secureCookies: baseUrl.startsWith('https'),
  redirectUri: `${baseUrl}/auth/kick/callback`,
  webhookUrl: `${baseUrl}/webhooks/kick`,
});

// # Constantes fijas del servicio y de la API de Kick
const KICK = Object.freeze({
  api: 'https://api.kick.com/public/v1',
  oauth: 'https://id.kick.com/oauth',
  scopes: 'user:read channel:read chat:write events:subscribe',
});

const LIMITS = Object.freeze({
  pendingTtlMs: 12 * 3600 * 1000,
  sessionTtlMs: 30 * 24 * 3600 * 1000,
  unknownDurationSec: 15 * 60,
  maxSseClients: 1500,
  apiRequestsPerMinute: 240,
  authRequestsPerMinute: 30,
  webhookMaxAgeMs: 10 * 60 * 1000,
});

module.exports = { ROOT, CFG, KICK, LIMITS };

'use strict';
const crypto = require('node:crypto');

// # Token aleatorio seguro para URL (n bytes)
const rand = (n) => crypto.randomBytes(n).toString('base64url');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const log = (...args) => console.log(new Date().toISOString(), ...args);

// # Convierte a número entero dentro de [lo, hi]; si no es válido devuelve el valor por defecto
function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

// # Limpia una lista de usuarios: minúsculas, sin "@", sin vacíos ni repetidos
function normalizeNames(list, max = 500) {
  const names = (Array.isArray(list) ? list : []).map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  return [...new Set(names)].slice(0, max);
}

module.exports = { rand, sha256, log, clamp, normalizeNames };

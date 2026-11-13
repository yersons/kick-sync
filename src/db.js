'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CFG } = require('./config');
const { migrateChannel } = require('./models');

// # Base de datos: un solo JSON en memoria que se guarda de forma atómica en disco
fs.mkdirSync(CFG.dataDir, { recursive: true });
const DB_FILE = path.join(CFG.dataDir, 'db.json');
const BACKUP_DIR = path.join(CFG.dataDir, 'backups');
const BACKUP_RE = /^db-.*\.json$/;

const db = { users: {}, channels: {}, sessions: {}, meta: {} };

function load() {
  try {
    Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    if (!fs.existsSync(DB_FILE)) return;
    // # Archivo ilegible: se aparta una copia y se arranca vacío sin pisarlo
    const copy = `${DB_FILE}.corrupta-${Date.now()}`;
    try {
      fs.copyFileSync(DB_FILE, copy);
      console.error('db.json ilegible, copia en', copy);
    } catch {}
  }
}

load();
db.meta = Object.assign({ announcement: '', maintenance: false, signupsOpen: true, allowList: [], audit: [] }, db.meta || {});
Object.values(db.channels).forEach(migrateChannel);

function flush() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

// # Guarda con retraso para agrupar muchos cambios seguidos en una sola escritura
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flush();
    } catch (e) {
      console.error('save', e);
    }
  }, 400);
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).sort().reverse();
  } catch {
    return [];
  }
}

// # Copia db.json a data/backups y conserva solo las últimas BACKUP_KEEP
function makeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  flush();
  const name = `db-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.json`;
  const target = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DB_FILE, target);
  fs.chmodSync(target, 0o600);
  for (const old of listBackups().slice(CFG.backupKeep)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    } catch {}
  }
  return name;
}

// # Registro de acciones del owner (se conservan las últimas 100)
function audit(who, action, target = '') {
  db.meta.audit.unshift({ t: Date.now(), who: String(who), action, target: String(target) });
  db.meta.audit.length = Math.min(db.meta.audit.length, 100);
  save();
}

function dbSizeBytes() {
  try {
    return fs.statSync(DB_FILE).size;
  } catch {
    return 0;
  }
}

module.exports = { db, save, flush, makeBackup, listBackups, audit, dbSizeBytes, DB_FILE, BACKUP_DIR };

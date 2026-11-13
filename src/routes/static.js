'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../config');
const { HttpError } = require('../http');
const { sessionUser } = require('../auth');
const { isPlatformOwner } = require('../channels');

const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// # Páginas fijas; /owner se resuelve aparte porque solo existe para el owner
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/dashboard': 'dashboard.html', '/favicon.svg': 'favicon.svg', '/favicon.ico': 'favicon.svg' };
const ASSET_RE = /^\/(css|js)\/[A-Za-z0-9_-]+\.(css|js)$/; // lista cerrada: imposible salir de public/
const PLAYER_RE = /^\/p\/[a-z0-9_-]+\/?$/i;

function sendFile(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'not_found');
  const headers = {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  };
  if (name !== 'player.html') headers['x-frame-options'] = 'DENY'; // el reproductor sí puede incrustarse
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname) {
  if (PAGES[pathname]) return sendFile(res, PAGES[pathname]);
  if (ASSET_RE.test(pathname)) return sendFile(res, pathname.slice(1));
  if (PLAYER_RE.test(pathname)) return sendFile(res, 'player.html');
  if (pathname === '/owner') {
    if (!isPlatformOwner(sessionUser(req))) throw new HttpError(404, 'not_found');
    return sendFile(res, 'owner.html');
  }
  throw new HttpError(404, 'not_found');
}

module.exports = { serveStatic };

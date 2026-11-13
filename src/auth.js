'use strict';
const crypto = require('node:crypto');
const { CFG, KICK, LIMITS } = require('./config');
const { db, save } = require('./db');
const { HttpError, redirect, parseCookies } = require('./http');
const { kickRequest, ensureSubscription } = require('./kick');
const { changed } = require('./realtime');
const { rand, sha256, log } = require('./utils');

const pendingAuth = new Map(); // state -> { verifier, next, exp } del login en curso

// # Limpia logins a medias y sesiones vencidas
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingAuth) if (value.exp < now) pendingAuth.delete(key);
  for (const [key, value] of Object.entries(db.sessions)) if (value.exp < now) delete db.sessions[key];
}, 600000).unref();

const sessionCookie = (value, maxAgeSec) =>
  `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${CFG.secureCookies ? '; Secure' : ''}`;

// # Solo se permiten redirecciones internas (evita open redirect)
const safeNext = (next) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');

// # Las sesiones se guardan con hash: la cookie es el único lugar con el valor real
function sessionUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const session = db.sessions[sha256(sid)];
  if (!session || session.exp < Date.now()) return null;
  return db.users[session.userId] || null;
}

function requireUser(req) {
  const user = sessionUser(req);
  if (!user) throw new HttpError(401, 'no_autenticado');
  return user;
}

function destroySession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return;
  delete db.sessions[sha256(sid)];
  save();
}

// # Paso 1 del OAuth: redirige a Kick con PKCE
function login(req, res, url) {
  if (!CFG.clientId || !CFG.clientSecret) throw new HttpError(500, 'Falta KICK_CLIENT_ID / KICK_CLIENT_SECRET en el .env');
  const verifier = rand(48);
  const state = rand(24);
  pendingAuth.set(state, { verifier, next: safeNext(url.searchParams.get('next')), exp: Date.now() + 600000 });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CFG.clientId,
    redirect_uri: CFG.redirectUri,
    scope: KICK.scopes,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
  });
  redirect(res, `${KICK.oauth}/authorize?${query}`);
}

// # Paso 2 del OAuth: canjea el código, guarda tokens y abre la sesión
async function callback(req, res, url) {
  const stateKey = url.searchParams.get('state') || '';
  const pending = pendingAuth.get(stateKey);
  pendingAuth.delete(stateKey);

  const error = url.searchParams.get('error');
  if (error) return redirect(res, `/?error=${encodeURIComponent(error)}`);
  if (!pending || pending.exp < Date.now()) return redirect(res, '/?error=sesion_expirada');
  const code = url.searchParams.get('code');
  if (!code) return redirect(res, '/?error=sin_codigo');

  const token = await kickRequest('POST', `${KICK.oauth}/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
      redirect_uri: CFG.redirectUri,
      code_verifier: pending.verifier,
      code,
    },
  });
  if (!token.ok || !token.data?.access_token) {
    log('token', token.status, JSON.stringify(token.data));
    return redirect(res, '/?error=token_fallido');
  }

  const me = await kickRequest('GET', `${KICK.api}/users`, { token: token.data.access_token });
  const profile = me.data?.data?.[0];
  if (!profile?.user_id) {
    log('users', me.status, JSON.stringify(me.data));
    return redirect(res, '/?error=usuario_fallido');
  }

  const id = String(profile.user_id);
  const user = (db.users[id] ||= { id });
  user.name = profile.name;
  user.picture = profile.profile_picture || '';
  user.tokens = {
    access: token.data.access_token,
    refresh: token.data.refresh_token,
    expiresAt: Date.now() + (token.data.expires_in || 3600) * 1000,
    scope: token.data.scope,
  };
  user.tokenError = false;

  const sid = rand(32);
  db.sessions[sha256(sid)] = { userId: id, exp: Date.now() + LIMITS.sessionTtlMs };
  save();

  const ch = db.channels[id];
  if (ch) {
    ch.name = user.name;
    if (!ch.subscriptionId) ensureSubscription(ch).then(() => changed(ch)).catch((e) => log('sub', e.message));
  }
  redirect(res, pending.next, { 'set-cookie': sessionCookie(sid, LIMITS.sessionTtlMs / 1000) });
}

module.exports = { sessionUser, requireUser, destroySession, login, callback };

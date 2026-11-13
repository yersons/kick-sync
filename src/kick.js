'use strict';
const crypto = require('node:crypto');
const { CFG, KICK } = require('./config');
const { db, save } = require('./db');
const { log } = require('./utils');

// # Petición genérica a la API de Kick; devuelve { status, ok, data } sin lanzar por HTTP != 2xx
async function kickRequest(method, url, { token, body, form } = {}) {
  const headers = { accept: 'application/json' };
  let payload;
  if (token) headers.authorization = `Bearer ${token}`;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

// # Devuelve un access token válido; renueva con el refresh token (una sola renovación a la vez por usuario)
const refreshing = new Map();
async function ensureToken(user) {
  const tokens = user.tokens;
  if (!tokens) throw new Error('sin_token');
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.access;
  if (!refreshing.has(user.id)) {
    refreshing.set(user.id, refreshTokens(user, tokens).finally(() => refreshing.delete(user.id)));
  }
  return refreshing.get(user.id);
}

async function refreshTokens(user, old) {
  const res = await kickRequest('POST', `${KICK.oauth}/token`, {
    form: { grant_type: 'refresh_token', client_id: CFG.clientId, client_secret: CFG.clientSecret, refresh_token: old.refresh },
  });
  if (!res.ok || !res.data?.access_token) {
    user.tokenError = true;
    save();
    throw new Error('refresh_fallido');
  }
  user.tokens = {
    access: res.data.access_token,
    refresh: res.data.refresh_token || old.refresh,
    expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000,
    scope: res.data.scope || old.scope,
  };
  user.tokenError = false;
  save();
  return user.tokens.access;
}

// # Clave pública con la que Kick firma sus webhooks (en caché)
let publicKeyCache = CFG.testPublicKey || null;
async function getPublicKey(force = false) {
  if (CFG.testPublicKey) return CFG.testPublicKey;
  if (publicKeyCache && !force) return publicKeyCache;
  const res = await kickRequest('GET', `${KICK.api}/public-key`);
  const key = res.data?.data?.public_key;
  if (!key) throw new Error('sin_public_key');
  publicKeyCache = key;
  return key;
}

function verifySignature(pem, messageId, timestamp, rawBody, signature) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${messageId}.${timestamp}.${rawBody}`);
    return verifier.verify(pem, signature, 'base64');
  } catch {
    return false;
  }
}

// # Suscribe el canal a los mensajes del chat (reutiliza la suscripción si ya existe)
async function ensureSubscription(ch) {
  const token = await ensureToken(db.users[ch.id]);
  try {
    const list = await kickRequest('GET', `${KICK.api}/events/subscriptions`, { token });
    const existing = (list.data?.data || []).find(
      (s) => (s.event === 'chat.message.sent' || s.name === 'chat.message.sent') && String(s.broadcaster_user_id) === ch.id,
    );
    if (existing) {
      ch.subscriptionId = existing.id || existing.subscription_id || 'existing';
      ch.subError = null;
      return save();
    }
  } catch (e) {
    log('list subs', e.message);
  }

  const res = await kickRequest('POST', `${KICK.api}/events/subscriptions`, {
    token,
    body: { broadcaster_user_id: Number(ch.id), events: [{ name: 'chat.message.sent', version: 1 }], method: 'webhook' },
  });
  const item = res.data?.data?.[0];
  if (res.ok && item && !item.error && item.subscription_id) {
    ch.subscriptionId = item.subscription_id;
    ch.subError = null;
    return save();
  }
  ch.subscriptionId = null;
  ch.subError = item?.error || res.data?.message || `HTTP ${res.status}`;
  save();
  throw new Error(ch.subError);
}

// # Da de baja el webhook en Kick (mejor esfuerzo)
async function removeSubscription(ch) {
  const owner = db.users[ch.id];
  if (!ch.subscriptionId || ch.subscriptionId === 'existing' || !owner) return;
  try {
    const token = await ensureToken(owner);
    await kickRequest('DELETE', `${KICK.api}/events/subscriptions?id=${encodeURIComponent(ch.subscriptionId)}`, { token });
  } catch (e) {
    log('unsub', e.message);
  }
}

// # Escribe en el chat del canal (solo si el streamer activó las respuestas)
async function say(ch, text) {
  if (!ch.settings.chatReplies) return;
  try {
    const token = await ensureToken(db.users[ch.id]);
    await kickRequest('POST', `${KICK.api}/chat`, {
      token,
      body: { broadcaster_user_id: Number(ch.id), content: String(text).slice(0, 480), type: 'user' },
    });
  } catch (e) {
    log('say', e.message);
  }
}

module.exports = { kickRequest, ensureToken, getPublicKey, verifySignature, ensureSubscription, removeSubscription, say };

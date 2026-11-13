'use strict';
// # Prueba de humo: arranca el servidor con una BD sembrada, firma un webhook como lo haría Kick
// # y recorre pendiente → aprobada → reproduciendo → saltar, además de los permisos y el SSE.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3999;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksync-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const mkSession = (sid, userId) => ({ [sha(sid)]: { userId, exp: Date.now() + 3600e3 } });
const db = {
  users: {
    '100': { id: '100', name: 'Streamer', tokens: { access: 'x', refresh: 'y', expiresAt: Date.now() + 3600e3 } },
    '200': { id: '200', name: 'ModAmigo' },
    '300': { id: '300', name: 'Random' },
    '400': { id: '400', name: 'Otro' },
    '999': { id: '999', name: 'Owner' },
  },
  channels: {},
  sessions: { ...mkSession('S100', '100'), ...mkSession('S200', '200'), ...mkSession('S300', '300'), ...mkSession('S400', '400'), ...mkSession('S999', '999') },
};
db.channels['100'] = {
  id: '100', slug: 'streamer', name: 'Streamer', playerKey: 'KEY123', subscriptionId: 'sub', subError: null,
  settings: { enabled: true, command: '!sr', requireApproval: true, autoApproveMods: true, trustBadgeMods: true, maxPerUser: 2, maxQueue: 50, maxDurationMin: 10, cooldownSec: 0, chatReplies: false, mods: ['modamigo'], volume: 60 },
  detectedMods: {}, pending: [], queue: [], history: [], playback: { song: null, startedAt: 0, paused: false, pausedPos: 0 },
};
// # canal secundario sin suscripción (para probar el borrado sin tocar la red) y con BD "antigua" (sin campos nuevos)
db.channels['400'] = {
  id: '400', slug: 'otro', name: 'Otro', playerKey: 'KEY400', subscriptionId: null, subError: null,
  settings: { enabled: true, command: '!sr', requireApproval: true, mods: [] },
  detectedMods: {}, pending: [], queue: [], history: [], playback: { song: null, startedAt: 0, paused: false, pausedPos: 0 },
};
fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db));

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, BASE_URL: `http://127.0.0.1:${PORT}`, DATA_DIR: dir, KICK_PUBLIC_KEY_PEM: pem, KICK_CLIENT_ID: 'id', KICK_CLIENT_SECRET: 'sec', OWNER_ID: '999' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (sid) => ({ cookie: 'sid=' + sid, 'content-type': 'application/json', 'x-requested-with': 'sync' });
const call = async (m, p, sid, body) => {
  const r = await fetch(B + p, { method: m, headers: sid ? H(sid) : { 'x-requested-with': 'sync', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
let n = 0;
async function webhook(content, { id = '300', name = 'Random', badges = [], signOk = true } = {}) {
  const body = JSON.stringify({ message_id: 'm' + ++n, broadcaster: { user_id: 100, username: 'Streamer' }, sender: { user_id: Number(id), username: name, identity: { badges } }, content });
  const mid = 'evt-' + n, ts = new Date().toISOString();
  const s = crypto.createSign('RSA-SHA256'); s.update(`${mid}.${ts}.${body}`);
  const sig = signOk ? s.sign(privateKey, 'base64') : 'AAAA';
  const r = await fetch(B + '/webhooks/kick', { method: 'POST', body, headers: { 'kick-event-message-id': mid, 'kick-event-message-timestamp': ts, 'kick-event-signature': sig, 'kick-event-type': 'chat.message.sent', 'kick-event-subscription-id': 's', 'kick-event-version': '1' } });
  await sleep(250);
  return r.status;
}
const state = async () => (await call('GET', '/api/p/streamer/state')).json;
const dash = async (sid = 'S100', channel = 100) => {
  const r = await fetch(B + `/api/c/${channel}/events`, { headers: { cookie: 'sid=' + sid } });
  if (r.status !== 200) return { status: r.status };
  const reader = r.body.getReader(); const { value } = await reader.read(); reader.cancel();
  return { status: 200, st: JSON.parse(new TextDecoder().decode(value).split('data: ')[1]) };
};

(async () => {
  try {
    for (let i = 0; i < 30; i++) { try { await fetch(B + '/healthz'); break; } catch { await sleep(100); } }
    assert.equal((await call('GET', '/healthz')).json.ok, true);

    // # firma inválida rechazada, válida aceptada
    assert.equal(await webhook('!sr https://youtu.be/dQw4w9WgXcQ', { signOk: false }), 401);
    assert.equal(await webhook('!sr https://youtu.be/dQw4w9WgXcQ'), 200);
    let d = await dash();
    assert.equal(d.st.pending.length, 1, 'la petición de un espectador queda pendiente');
    assert.equal(d.st.pending[0].by, 'Random');
    assert.equal(d.st.playback.song, null);

    // # duplicado y comandos inválidos
    await webhook('!sr https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3');
    await webhook('!sr nada valido');
    await webhook('!otra cosa');
    assert.equal((await dash()).st.pending.length, 1, 'sin duplicados ni basura');

    // # permisos: un random no entra al panel, el mod de la lista sí
    assert.equal((await dash('S300')).status, 403);
    assert.equal((await dash('S200')).status, 200);
    assert.equal((await call('POST', '/api/c/100/action', 'S300', { type: 'skip' })).status, 403);
    assert.equal((await call('PUT', '/api/c/100/settings', 'S200', {})).status, 403, 'mod no edita configuración');
    // # CSRF: sin cabecera custom
    const csrf = await fetch(B + '/api/c/100/action', { method: 'POST', headers: { cookie: 'sid=S100', 'content-type': 'application/json' }, body: '{"type":"skip"}' });
    assert.equal(csrf.status, 403);

    // # aprobar → empieza a sonar
    const id = d.st.pending[0].id;
    assert.equal((await call('POST', '/api/c/100/action', 'S200', { type: 'approve', id })).status, 200);
    let s = await state();
    assert.equal(s.playback.song.videoId, 'dQw4w9WgXcQ');
    assert.equal(s.playback.paused, false);

    // # un mod pide: se aprueba solo y va a la cola
    await webhook('!sr https://youtu.be/9bZkp7q19f0', { id: '200', name: 'ModAmigo', badges: [{ type: 'moderator', text: 'Moderator' }] });
    s = await state();
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].videoId, '9bZkp7q19f0');
    assert.ok((await dash()).st.detectedMods.includes('ModAmigo'));

    // # pausa / reanudar / seek mantienen la posición
    await call('POST', '/api/c/100/action', 'S100', { type: 'seek', seconds: 50 });
    await call('POST', '/api/c/100/action', 'S100', { type: 'pause' });
    s = await state();
    assert.equal(s.playback.paused, true);
    assert.ok(Math.abs(s.playback.pausedPos - 50) < 1.5);
    await call('POST', '/api/c/100/action', 'S100', { type: 'resume' });
    s = await state();
    assert.equal(s.playback.paused, false);
    assert.ok(Math.abs((s.serverNow - s.playback.startedAt) / 1000 - 50) < 2);

    // # el reproductor maestro: clave incorrecta rechazada, correcta avanza
    const bad = await call('POST', '/api/p/streamer/ended', null, { key: 'nope', songId: s.playback.song.id });
    assert.equal(bad.status, 403);
    await call('POST', '/api/p/streamer/ended', null, { key: 'KEY123', songId: 'otra-cancion' });
    assert.equal((await state()).playback.song.videoId, 'dQw4w9WgXcQ', 'ended con songId ajeno se ignora');
    await call('POST', '/api/p/streamer/ended', null, { key: 'KEY123', songId: s.playback.song.id });
    s = await state();
    assert.equal(s.playback.song.videoId, '9bZkp7q19f0');
    assert.equal(s.queue.length, 0);

    // # !skip de mod, !undo de usuario
    await webhook('!skip', { id: '200', name: 'ModAmigo', badges: [{ type: 'moderator' }] });
    assert.equal((await state()).playback.song, null);
    await webhook('!sr https://youtu.be/kJQP7kiw5Fk');
    assert.equal((await dash()).st.pending.length, 1);
    await webhook('!undo');
    assert.equal((await dash()).st.pending.length, 0);

    // # límite por usuario (2)
    await webhook('!sr https://youtu.be/aaaaaaaaaaa'); await webhook('!sr https://youtu.be/bbbbbbbbbbb'); await webhook('!sr https://youtu.be/ccccccccccc');
    assert.equal((await dash()).st.pending.length, 2);

    // # páginas y OAuth
    assert.equal((await fetch(B + '/')).status, 200);
    assert.equal((await fetch(B + '/p/streamer')).status, 200);
    assert.equal((await fetch(B + '/dashboard')).status, 200);
    const lg = await fetch(B + '/auth/kick/login', { redirect: 'manual' });
    const loc = new URL(lg.headers.get('location'));
    assert.equal(lg.status, 302);
    assert.equal(loc.origin + loc.pathname, 'https://id.kick.com/oauth/authorize');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('redirect_uri'), `${B}/auth/kick/callback`);
    assert.ok(loc.searchParams.get('code_challenge').length >= 43);
    const cb = await fetch(B + '/auth/kick/callback?code=x&state=malo', { redirect: 'manual' });
    assert.match(cb.headers.get('location'), /error=sesion_expirada/);

    // # archivos estáticos: css/js se sirven, cualquier otra ruta no
    assert.equal((await fetch(B + '/css/base.css')).status, 200);
    assert.equal((await fetch(B + '/js/dashboard.js')).status, 200);
    assert.equal((await fetch(B + '/js/../server.js')).status, 404);
    assert.equal((await fetch(B + '/src/config.js')).status, 404);

    // # migración: el canal "antiguo" recibe los campos que le faltaban
    assert.equal((await dash('S400', 400)).st.settings.skipVotes, 0);

    const SETTINGS = { enabled: true, command: '!sr', requireApproval: true, autoApproveMods: true, trustBadgeMods: true, chatReplies: false, maxPerUser: 2, maxQueue: 50, maxDurationMin: 10, cooldownSec: 0, volume: 60, mods: ['modamigo'], skipVotes: 2, blockedUsers: ['@Troll'] };
    assert.equal((await call('PUT', '/api/c/100/settings', 'S100', SETTINGS)).status, 200);

    await call('POST', '/api/c/100/action', 'S100', { type: 'approveAll' });
    s = await state();
    assert.equal(s.playback.song.videoId, 'aaaaaaaaaaa');
    assert.equal(s.queue.length, 1);
    await webhook('!sr https://youtu.be/eeeeeeeeeee', { id: '200', name: 'ModAmigo', badges: [{ type: 'moderator' }] });
    assert.equal((await state()).queue.length, 2);

    // # usuario bloqueado: ignorado en silencio
    const before = (await dash()).st.pending.length;
    await webhook('!sr https://youtu.be/ddddddddddd', { id: '666', name: 'Troll' });
    assert.equal((await dash()).st.pending.length, before, 'un usuario bloqueado no puede pedir');

    // # top / shuffle
    const q = (await state()).queue;
    await call('POST', '/api/c/100/action', 'S100', { type: 'top', id: q[1].id });
    assert.equal((await state()).queue[0].id, q[1].id, 'top lleva la canción al frente');
    await call('POST', '/api/c/100/action', 'S100', { type: 'shuffle' });
    assert.equal((await state()).queue.length, 2);

    // # votación para saltar: 2 votos distintos
    const playing = (await state()).playback.song.id;
    await webhook('!voteskip', { id: '300', name: 'Random' });
    await webhook('!voteskip', { id: '300', name: 'Random' });
    assert.equal((await state()).playback.song.id, playing, 'el mismo usuario no cuenta doble');
    await webhook('!voteskip', { id: '301', name: 'Otro2' });
    assert.notEqual((await state()).playback.song.id, playing, 'con 2 votos se salta');

    // # panel del dueño
    assert.equal((await call('GET', '/api/owner/overview', 'S100')).status, 403, 'el streamer no es owner');
    assert.equal((await call('GET', '/api/owner/overview', 'S200')).status, 403);
    assert.equal((await call('GET', '/api/owner/overview')).status, 401);
    assert.equal((await fetch(B + '/owner', { headers: { cookie: 'sid=S100', accept: 'text/html' } })).status, 404, '/owner no existe para otros');
    assert.equal((await fetch(B + '/owner', { headers: { cookie: 'sid=S999' } })).status, 200);
    let ov = await call('GET', '/api/owner/overview', 'S999');
    assert.equal(ov.status, 200);
    assert.equal(ov.json.totals.channels, 2);
    assert.ok(ov.json.totals.played >= 3);
    assert.equal((await call('GET', '/api/me', 'S999')).json.isPlatformOwner, true);
    assert.equal((await call('GET', '/api/me', 'S100')).json.isPlatformOwner, false);
    assert.equal((await call('GET', '/api/me', 'S999')).json.channels.length, 2, 'el owner ve todos los canales');
    assert.equal((await dash('S999')).status, 200, 'el owner entra al panel de cualquier canal');
    assert.equal((await call('PUT', '/api/owner/settings', 'S100', {})).status, 403);

    // # suspender: no entran peticiones, el reproductor público desaparece; reactivar lo devuelve
    assert.equal((await call('POST', '/api/owner/channel/100/suspend', 'S999')).status, 200);
    const qBefore = (await dash()).st.queueFull.length;
    await webhook('!sr https://youtu.be/fffffffffff', { id: '200', name: 'ModAmigo', badges: [{ type: 'moderator' }] });
    assert.equal((await dash()).st.queueFull.length, qBefore, 'canal suspendido ignora el chat');
    assert.equal((await call('GET', '/api/p/streamer/state')).status, 404);
    await call('POST', '/api/owner/channel/100/unsuspend', 'S999');
    assert.equal((await call('GET', '/api/p/streamer/state')).status, 200);

    // # mantenimiento + anuncio global
    assert.equal((await call('PUT', '/api/owner/settings', 'S999', { announcement: 'Mantenimiento 5 min', maintenance: true, signupsOpen: false, allowList: ['@Amigo'] })).status, 200);
    const me = (await call('GET', '/api/me', 'S300')).json;
    assert.equal(me.announcement, 'Mantenimiento 5 min');
    const q2 = (await dash()).st.queueFull.length;
    await webhook('!sr https://youtu.be/ggggggggggg', { id: '200', name: 'ModAmigo', badges: [{ type: 'moderator' }] });
    assert.equal((await dash()).st.queueFull.length, q2, 'en mantenimiento el chat se ignora');
    // # registros cerrados: un usuario nuevo fuera de la lista no puede activar canal
    assert.equal((await call('POST', '/api/channel/activate', 'S300')).status, 403);
    await call('PUT', '/api/owner/settings', 'S999', { announcement: '', maintenance: false, signupsOpen: true, allowList: [] });

    // # respaldo y exportación sin secretos
    const bk = await call('POST', '/api/owner/backup', 'S999');
    assert.equal(bk.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'backups', bk.json.name)));
    const ex = await (await fetch(B + '/api/owner/export', { headers: { cookie: 'sid=S999' } })).text();
    assert.ok(!ex.includes('KEY123') && !ex.includes('"refresh"') && !ex.includes('"tokens"'), 'la exportación no filtra claves ni tokens');
    assert.equal((await fetch(B + '/api/owner/export', { headers: { cookie: 'sid=S100' } })).status, 403);

    // # auditoría
    ov = await call('GET', '/api/owner/overview', 'S999');
    assert.ok(ov.json.audit.some((a) => a.action === 'owner:suspender'));

    // # borrar canal y cerrar sesiones
    assert.equal((await call('POST', '/api/owner/channel/400/delete', 'S999')).status, 200);
    assert.equal((await call('GET', '/api/p/otro/state')).status, 404);
    assert.equal((await call('POST', '/api/owner/channel/100/logout', 'S999')).json.closed, 1);
    assert.equal((await call('GET', '/api/me', 'S100')).json.user, null, 'sesión del streamer cerrada por el owner');

    // # rate limit (siempre al final: quema el cupo de la IP)
    let limited = 0;
    for (let i = 0; i < 300; i++) if ((await call('GET', '/api/me')).status === 429) limited++;
    assert.ok(limited > 0, 'el rate limit corta el abuso');

    console.log('✔ todas las pruebas pasaron');
  } catch (e) {
    console.error('✘ FALLÓ:', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

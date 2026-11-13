'use strict';
const { LIMITS } = require('./config');
const { db, save } = require('./db');
const { HttpError, json, readBody } = require('./http');
const { getPublicKey, verifySignature, say } = require('./kick');
const { changed } = require('./realtime');
const { requestSong, startNext, voteSkip, undoLast } = require('./playback');
const { log } = require('./utils');

// # Mensajes ya procesados (Kick puede repetir un evento); se recuerdan los últimos 3000
const seenMessages = new Set();
const markSeen = (id) => {
  if (seenMessages.has(id)) return false;
  seenMessages.add(id);
  if (seenMessages.size > 3000) seenMessages.delete(seenMessages.values().next().value);
  return true;
};

// # Recibe el webhook de Kick: valida cabeceras, antigüedad y firma RSA antes de procesar
async function handleWebhook(req, res) {
  const raw = (await readBody(req)).toString('utf8');
  const h = req.headers;
  const id = h['kick-event-message-id'];
  const timestamp = h['kick-event-message-timestamp'];
  const signature = h['kick-event-signature'];
  if (!id || !timestamp || !signature) return json(res, 400, { error: 'headers' });

  const sentAt = Date.parse(timestamp);
  if (Number.isFinite(sentAt) && Math.abs(Date.now() - sentAt) > LIMITS.webhookMaxAgeMs) {
    return json(res, 400, { error: 'timestamp_fuera_de_rango' });
  }

  // # Si la firma falla se reintenta con la clave pública renovada (Kick puede rotarla)
  let valid = verifySignature(await getPublicKey(), id, timestamp, raw, signature);
  if (!valid) valid = verifySignature(await getPublicKey(true), id, timestamp, raw, signature);
  if (!valid) return json(res, 401, { error: 'firma_invalida' });

  res.writeHead(200);
  res.end('ok');

  if (!markSeen(id) || h['kick-event-type'] !== 'chat.message.sent') return;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  onChat(event).catch((e) => log('onChat', e.message));
}

// # Interpreta un mensaje del chat: identifica quién escribe y ejecuta el comando
async function onChat(event) {
  const ch = db.channels[String(event.broadcaster?.user_id)];
  if (!ch || !ch.settings.enabled || ch.suspended || db.meta.maintenance || !event.sender) return;

  const senderId = String(event.sender.user_id);
  const senderName = event.sender.username || 'usuario';
  const badges = (event.sender.identity?.badges || []).map((b) => b.type);
  const isStreamer = senderId === ch.id || badges.includes('broadcaster');
  const hasModBadge = badges.includes('moderator');

  // # Se recuerda a los mods por insignia para darles acceso al panel
  if (hasModBadge && !isStreamer && ch.detectedMods[senderId] !== senderName) {
    ch.detectedMods[senderId] = senderName;
    save();
  }
  const isMod = isStreamer || hasModBadge || ch.settings.mods.includes(senderName.toLowerCase());
  if (!isMod && ch.settings.blockedUsers.includes(senderName.toLowerCase())) return;

  const [first, ...rest] = String(event.content || '').trim().split(/\s+/);
  const command = (first || '').toLowerCase();
  const args = rest.join(' ');
  if (command.startsWith('!')) ch.lastActive = Date.now();

  const ctx = { ch, senderId, senderName, isMod, args };
  if (command === ch.settings.command.toLowerCase()) return cmdRequest(ctx);

  return COMMANDS.get(command)?.(ctx);
}

// # Comandos fijos del chat (el de pedir canciones es configurable y se resuelve aparte)
const COMMANDS = new Map([
  ['!skip', cmdSkip],
  ['!undo', cmdUndo],
  ['!voteskip', cmdVoteSkip],
  ['!cola', cmdQueue],
  ['!queue', cmdQueue],
  ['!song', cmdNowPlaying],
  ['!cancion', cmdNowPlaying],
]);

async function cmdRequest({ ch, senderId, senderName, isMod, args }) {
  const result = await requestSong(ch, { id: senderId, name: senderName, isMod }, args);
  await say(ch, result.msg);
}

async function cmdSkip({ ch, isMod }) {
  if (!isMod || !ch.playback.song) return;
  startNext(ch);
  changed(ch);
  await say(ch, '⏭ Canción saltada.');
}

async function cmdUndo({ ch, senderId, senderName }) {
  const removed = undoLast(ch, senderId);
  if (!removed) return;
  changed(ch);
  await say(ch, `@${senderName} quité "${removed.title}".`);
}

async function cmdVoteSkip({ ch, senderId }) {
  if (ch.settings.skipVotes <= 0 || !ch.playback.song) return;
  const { reached, count } = voteSkip(ch, senderId);
  await say(ch, reached ? '⏭ Canción saltada por votación.' : `🗳 ${count}/${ch.settings.skipVotes} votos para saltar la canción.`);
}

async function cmdQueue({ ch }) {
  const next = ch.queue.slice(0, 3).map((s, i) => `${i + 1}) ${s.title}`).join(' · ');
  await say(ch, next ? `📜 Siguientes (${ch.queue.length} en cola): ${next}` : 'La cola está vacía.');
}

async function cmdNowPlaying({ ch }) {
  const song = ch.playback.song;
  await say(ch, song ? `🎶 Ahora suena: ${song.title} (pedida por ${song.by.name})` : 'No hay nada sonando.');
}

module.exports = { handleWebhook };

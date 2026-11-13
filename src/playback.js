'use strict';
const crypto = require('node:crypto');
const { CFG, LIMITS } = require('./config');
const { HttpError } = require('./http');
const { idlePlayback } = require('./models');
const { rand, clamp } = require('./utils');
const { changed } = require('./realtime');
const { parseVideoId, searchVideo, fetchVideoInfo } = require('./youtube');

const timers = new Map(); // canal -> temporizador de fin de canción
const cooldowns = new Map(); // "canal:usuario" -> última petición
const skipVotes = new Map(); // canal -> { songId, voters }

const positionOf = (pb) => (pb.paused ? pb.pausedPos : (Date.now() - pb.startedAt) / 1000);
const indexOfId = (list, id) => list.findIndex((s) => s.id === id);

// # Programa el avance automático al terminar la canción (con margen de 4 s)
function schedule(ch) {
  cancelTimer(ch);
  const pb = ch.playback;
  if (!pb.song || pb.paused) return;
  // Sin duración conocida la canción no terminaría nunca: se usa un tope de seguridad
  const total = pb.song.duration || LIMITS.unknownDurationSec;
  const ms = Math.max(1500, (total - positionOf(pb)) * 1000 + 4000);
  const songId = pb.song.id;
  timers.set(ch.id, setTimeout(() => {
    if (ch.playback.song?.id !== songId) return;
    startNext(ch);
    changed(ch);
  }, ms));
}

function cancelTimer(ch) {
  clearTimeout(timers.get(ch.id));
  timers.delete(ch.id);
}

function clearVotes(ch) {
  skipVotes.delete(ch.id);
}

// # Mueve la canción actual al historial (últimas 50)
function archive(ch, extra = {}) {
  const current = ch.playback.song;
  if (!current) return;
  ch.history.unshift({ ...current, playedAt: Date.now(), ...extra });
  ch.history.length = Math.min(ch.history.length, 50);
}

function begin(ch, song) {
  ch.playback = song ? { song, startedAt: Date.now(), paused: false, pausedPos: 0 } : idlePlayback();
  if (song) ch.stats.played++;
  schedule(ch);
}

const playSong = (ch, song) => { archive(ch); begin(ch, song); };
function startNext(ch, extra) {
  archive(ch, extra);
  begin(ch, ch.queue.shift());
}

// # Votación para saltar: cuenta un voto por usuario y salta al llegar al mínimo
function voteSkip(ch, userId) {
  const song = ch.playback.song;
  let vote = skipVotes.get(ch.id);
  if (!vote || vote.songId !== song.id) {
    vote = { songId: song.id, voters: new Set() };
    skipVotes.set(ch.id, vote);
  }
  vote.voters.add(userId);
  const reached = vote.voters.size >= ch.settings.skipVotes;
  if (reached) {
    clearVotes(ch);
    startNext(ch);
    changed(ch);
  }
  return { reached, count: vote.voters.size };
}

const fail = (msg) => ({ ok: false, msg });

// # Procesa una petición de canción (chat o panel) aplicando todas las reglas del canal
async function requestSong(ch, who, input, { force = false } = {}) {
  const s = ch.settings;
  input = String(input || '').trim();
  if (!input) return fail(`Uso: ${s.command} <link de YouTube${CFG.ytKey ? ' o nombre' : ''}>`);

  const isDuplicate = (videoId) =>
    ch.playback.song?.videoId === videoId ||
    ch.queue.some((x) => x.videoId === videoId) ||
    ch.pending.some((x) => x.videoId === videoId) ||
    ch.history.slice(0, 5).some((x) => x.videoId === videoId);
  const countMine = () => [...ch.pending, ...ch.queue].filter((x) => x.by.id === who.id).length;
  const duplicateMsg = `@${who.name} esa canción ya está en la cola.`;

  if (!who.isMod) {
    const last = cooldowns.get(`${ch.id}:${who.id}`) || 0;
    if (Date.now() - last < s.cooldownSec * 1000) return fail(`@${who.name} espera unos segundos antes de pedir otra.`);
    if (countMine() >= s.maxPerUser) return fail(`@${who.name} ya tienes ${s.maxPerUser} canciones en cola.`);
  }
  if (ch.pending.length + ch.queue.length >= s.maxQueue) return fail('La cola está llena.');

  let videoId = parseVideoId(input);
  if (!videoId && CFG.ytKey) videoId = await searchVideo(input);
  if (!videoId) return fail(`@${who.name} no encontré ese video. Envía un link de YouTube.`);
  if (isDuplicate(videoId)) return fail(duplicateMsg);
  if (!who.isMod) cooldowns.set(`${ch.id}:${who.id}`, Date.now());

  const info = await fetchVideoInfo(videoId);
  if (info.error) return fail(`@${who.name} ${info.error}`);
  const tooLong = info.duration && s.maxDurationMin > 0 && info.duration > s.maxDurationMin * 60;
  if (!force && !who.isMod && tooLong) return fail(`@${who.name} supera el máximo de ${s.maxDurationMin} min.`);
  if (isDuplicate(videoId)) return fail(duplicateMsg); // otra petición pudo entrar mientras se consultaba YouTube

  const song = {
    id: rand(9), videoId, title: info.title, channelTitle: info.channelTitle, duration: info.duration, thumb: info.thumb,
    by: { id: who.id, name: who.name }, at: Date.now(),
  };
  const approved = force || (who.isMod ? s.autoApproveMods : !s.requireApproval);
  if (approved) {
    ch.queue.push(song);
    if (!ch.playback.song) startNext(ch);
  } else {
    ch.pending.push(song);
  }
  ch.stats.requests++;
  changed(ch);

  const place = ch.queue.findIndex((x) => x.id === song.id) + 1;
  const msg = approved ? `🎵 "${song.title}" añadida a la cola${place ? ` (#${place})` : ''}.` : `🎵 "${song.title}" enviada a revisión de los mods.`;
  return { ok: true, auto: approved, song, msg };
}

// # Quita la última petición del usuario (pendientes primero, luego cola)
function undoLast(ch, userId) {
  for (const list of [ch.pending, ch.queue]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].by.id === userId) return list.splice(i, 1)[0];
    }
  }
  return null;
}

// # Acciones del panel: cada una modifica la cola o la reproducción y al final se notifica a todos
async function doAction(ch, user, action) {
  const pb = ch.playback;
  const id = String(action.id || '');

  const actions = {
    approve() {
      const i = indexOfId(ch.pending, id);
      if (i < 0) return;
      ch.queue.push(...ch.pending.splice(i, 1));
      if (!pb.song) startNext(ch);
    },
    approveAll() {
      ch.queue.push(...ch.pending.splice(0));
      if (!pb.song) startNext(ch);
    },
    reject() {
      const i = indexOfId(ch.pending, id);
      if (i >= 0) ch.pending.splice(i, 1);
    },
    clearPending: () => { ch.pending.length = 0; },
    clearQueue: () => { ch.queue.length = 0; },
    remove() {
      const i = indexOfId(ch.queue, id);
      if (i >= 0) ch.queue.splice(i, 1);
    },
    play() {
      let i = indexOfId(ch.queue, id);
      let song;
      if (i >= 0) [song] = ch.queue.splice(i, 1);
      else if ((i = indexOfId(ch.pending, id)) >= 0) [song] = ch.pending.splice(i, 1);
      if (song) playSong(ch, song);
    },
    move() {
      const i = indexOfId(ch.queue, id);
      const j = i + (action.dir < 0 ? -1 : 1);
      if (i >= 0 && j >= 0 && j < ch.queue.length) [ch.queue[i], ch.queue[j]] = [ch.queue[j], ch.queue[i]];
    },
    top() {
      const i = indexOfId(ch.queue, id);
      if (i > 0) ch.queue.unshift(...ch.queue.splice(i, 1));
    },
    shuffle() {
      for (let i = ch.queue.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [ch.queue[i], ch.queue[j]] = [ch.queue[j], ch.queue[i]];
      }
    },
    skip() {
      if (pb.song) startNext(ch);
    },
    pause() {
      if (!pb.song || pb.paused) return;
      pb.pausedPos = positionOf(pb);
      pb.paused = true;
      schedule(ch);
    },
    resume() {
      if (!pb.song || !pb.paused) return;
      pb.startedAt = Date.now() - pb.pausedPos * 1000;
      pb.paused = false;
      schedule(ch);
    },
    seek() {
      if (!pb.song) return;
      const seconds = Math.max(0, Number(action.seconds) || 0);
      if (pb.paused) pb.pausedPos = seconds;
      else pb.startedAt = Date.now() - seconds * 1000;
      schedule(ch);
    },
    volume() {
      ch.settings.volume = clamp(action.value, 0, 100, ch.settings.volume);
    },
  };

  if (action.type === 'add') {
    const result = await requestSong(ch, { id: user.id, name: user.name, isMod: true }, action.url, { force: true });
    return { ok: result.ok, msg: result.msg };
  }
  if (!Object.hasOwn(actions, action.type)) throw new HttpError(400, 'accion_desconocida');
  actions[action.type]();
  changed(ch);
  return { ok: true };
}

module.exports = { schedule, cancelTimer, clearVotes, startNext, voteSkip, requestSong, undoLast, doAction };

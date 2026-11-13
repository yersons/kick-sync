// # Panel del canal: cola, aprobaciones, reproducción y configuración
const ERRORS = {
  registros_cerrados: 'Los registros están cerrados por ahora. Pídele acceso al administrador.',
  canal_suspendido: 'Tu canal está suspendido por el administrador.',
  sin_permiso: 'No tienes permiso para eso.',
  demasiadas_peticiones: 'Vas muy rápido, espera unos segundos.',
  no_autenticado: 'Tu sesión expiró: vuelve a entrar.',
};

let me;
let channelId;
let source;
let state;
let clockOffset = 0;
let prevPending = null;
let configSnapshot = '';
let soundOn = localStorage.getItem('snd') === '1';

const act = (body) => api('POST', `/api/c/${channelId}/action`, body).catch((e) => toast(`Error: ${e.message}`));

// ───────────── Aviso sonoro ─────────────
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}

const paintSoundButton = () => ($('#snd').textContent = soundOn ? 'Aviso: on' : 'Aviso: off');
$('#snd').onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem('snd', soundOn ? '1' : '0');
  paintSoundButton();
  if (soundOn) beep();
};
paintSoundButton();

// ───────────── Inicio de sesión y selección de canal ─────────────
async function init() {
  me = await api('GET', '/api/me');
  if (!me.user) {
    location.href = '/auth/kick/login?next=/dashboard';
    return;
  }
  renderHeader();
  if (!me.channels.length) return renderActivateCard();

  const select = $('#chsel');
  select.innerHTML = me.channels
    .map((c) => `<option value="${c.id}">${esc(c.name)}${c.isOwner ? ' (mío)' : ''}${c.suspended ? ' (suspendido)' : ''}</option>`)
    .join('');
  const wanted = new URLSearchParams(location.search).get('ch') || localStorage.getItem('ch');
  select.value = me.channels.some((c) => c.id === wanted) ? wanted : me.channels[0].id;
  select.onchange = () => connect(select.value);

  if (!me.ownChannel) {
    const button = document.createElement('button');
    button.className = 'btn sm';
    button.textContent = 'Activar mi canal';
    button.onclick = activate;
    $('header .sp').after(button);
  }
  connect(select.value);
}

function renderHeader() {
  $('#who').textContent = me.user.name;
  $('#who').onclick = () => {
    navigator.clipboard?.writeText(me.user.id);
    toast(`ID de Kick copiado: ${me.user.id}`);
  };
  if (me.user.picture) {
    $('#av').src = me.user.picture;
    $('#av').hidden = false;
  }
  if (me.isPlatformOwner) {
    $('#ownerlink').hidden = false;
    $('#ownertag').hidden = false;
  }
  if (me.announcement) showBanner(`AVISO: ${me.announcement}`);
  if (me.maintenance) showBanner(`Mantenimiento: el chat está pausado temporalmente. ${me.announcement || ''}`);
  $('#logout').onclick = async () => {
    await api('POST', '/auth/logout');
    location.href = '/';
  };
}

function showBanner(text) {
  $('#ann').textContent = text;
  $('#ann').hidden = false;
}

function renderActivateCard() {
  const card = $('#center');
  card.hidden = false;
  card.innerHTML = `<h2>Hola, ${esc(me.user.name)}</h2>
    <p class="muted">Aún no tienes acceso a ningún canal. Si eres el streamer, activa Kick Sync en tu canal. Si eres mod, pídele al streamer que te agregue en su configuración (o que hables en su chat con la insignia de mod).</p>
    <button class="btn pri" id="act">Activar en mi canal</button>`;
  $('#act').onclick = activate;
}

async function activate() {
  try {
    const result = await api('POST', '/api/channel/activate');
    if (result.warn) {
      alert(`Canal creado, pero Kick no aceptó la suscripción al chat:\n${result.warn}\n\nRevisa que los webhooks estén activados y con la URL correcta en tu app de Kick.`);
    }
    location.reload();
  } catch (e) {
    toast(ERRORS[e.message] || `Error: ${e.message}`);
  }
}

function connect(id) {
  channelId = id;
  localStorage.setItem('ch', id);
  prevPending = null;
  $('#center').hidden = true;
  $('#app').hidden = false;
  source?.close();
  source = listenState(`/api/c/${id}/events`, (newState, offset) => {
    state = newState;
    clockOffset = offset;
    render();
  });
}

// ───────────── Dibujo del panel ─────────────
function songRow(song, buttons = '', extra = '') {
  return `<div class="song">
    <img loading="lazy" src="${esc(song.thumb)}" alt="">
    <div class="grow">
      <div class="t" title="${esc(song.title)}">${esc(song.title)}</div>
      <div class="m">${esc(song.channelTitle)}${song.duration ? ` · ${formatTime(song.duration)}` : ''} · pedida por <b>${esc(song.by)}</b>${extra}</div>
    </div>
    <div class="act">${buttons}</div>
  </div>`;
}

const actionButton = (label, action, id, { cls = '', title = '', disabled = false, dir = '' } = {}) =>
  `<button class="btn sm ${cls}" data-a="${action}" data-id="${id}"${dir ? ` data-dir="${dir}"` : ''}${title ? ` title="${title}"` : ''}${disabled ? ' disabled' : ''}>${label}</button>`;

function render() {
  const { playback: pb } = state;
  $('#subpill').className = `pill ${state.subscribed ? 'ok' : 'err'}`;
  $('#subpill').textContent = state.subscribed ? 'chat conectado' : 'chat sin conectar';
  $('#cmdhint').textContent = state.command;
  $('#susp').hidden = !state.suspended;
  $('#eq').className = `eq${pb.song && !pb.paused ? '' : ' off'}`;
  $('#stats').textContent = state.stats ? `${state.stats.played} reproducidas · ${state.stats.requests} pedidas` : '';

  if (prevPending !== null && state.pending.length > prevPending && soundOn) beep();
  prevPending = state.pending.length;
  document.title = `${state.pending.length ? `(${state.pending.length}) ` : ''}Panel · Kick Sync`;

  renderNowPlaying(pb);
  renderPending();
  renderQueue();
  $('#history').innerHTML = state.history.length
    ? state.history.map((s) => songRow(s, '', s.error ? ` · <span class="error-text">${esc(s.error)}</span>` : '')).join('')
    : '<div class="empty">Aún no hay historial.</div>';
  renderLinks();
  renderSettings();
}

function renderNowPlaying(pb) {
  if (!pb.song) {
    $('#np').innerHTML = '<div class="empty">No hay nada sonando. Aprueba una canción o añade un link.</div>';
    return;
  }
  const song = pb.song;
  $('#np').innerHTML = `
    <div class="np">
      <img src="${esc(song.thumb)}" alt="">
      <div style="min-width:0"><h3>${esc(song.title)}</h3><div class="muted sm">${esc(song.channelTitle)} · pedida por <b>${esc(song.by)}</b></div></div>
    </div>
    <div class="np-progress">
      <div class="bar" id="seek"><i id="prog"></i></div>
      <div class="muted sm np-times"><span id="tcur">0:00</span><span>${song.duration ? formatTime(song.duration) : '—'}</span></div>
    </div>
    <div class="ctl">
      <button class="btn" data-a="${pb.paused ? 'resume' : 'pause'}">${pb.paused ? 'Reanudar' : 'Pausar'}</button>
      <button class="btn" data-a="skip">Saltar</button>
      <label class="muted sm">Volumen OBS <input type="range" min="0" max="100" value="${state.volume}" id="vol"></label>
    </div>`;
  updateProgress();
}

function renderPending() {
  $('#pcount').textContent = state.pending.length;
  $('#pending').innerHTML = state.pending.length
    ? state.pending
        .map((s) => songRow(s, [
          actionButton('Aprobar', 'approve', s.id, { cls: 'pri' }),
          actionButton('Reproducir', 'play', s.id, { title: 'Reproducir ya' }),
          actionButton('Rechazar', 'reject', s.id, { cls: 'bad' }),
        ].join('')))
        .join('')
    : '<div class="empty">Sin peticiones pendientes.</div>';
}

function renderQueue() {
  const queue = state.queueFull;
  $('#qcount').textContent = queue.length;
  $('#queue').innerHTML = queue.length
    ? queue
        .map((s, i) => songRow(s, [
          actionButton('Reproducir', 'play', s.id, { title: 'Reproducir ya' }),
          actionButton('Frente', 'top', s.id, { title: 'Pasar al frente', disabled: i === 0 }),
          actionButton('Subir', 'move', s.id, { dir: -1, disabled: i === 0 }),
          actionButton('Bajar', 'move', s.id, { dir: 1, disabled: i === queue.length - 1 }),
          actionButton('Quitar', 'remove', s.id, { cls: 'bad' }),
        ].join(''), ` · #${i + 1}`))
        .join('')
    : '<div class="empty">La cola está vacía.</div>';
}

function renderLinks() {
  $('#lpub').value = `${location.origin}/p/${state.slug}`;
  $('#obsbox').hidden = !state.isOwner;
  if (state.isOwner) $('#lobs').value = `${location.origin}/p/${state.slug}?key=${state.playerKey}`;
}

// # Barra de progreso de la canción actual (se refresca cada 0.5 s)
function updateProgress() {
  if (!state?.playback.song) return;
  const { playback: pb } = state;
  const position = pb.paused ? pb.pausedPos : (Date.now() + clockOffset - pb.startedAt) / 1000;
  const bar = $('#prog');
  if (!bar) return;
  bar.style.width = `${pb.song.duration ? Math.min(100, (position / pb.song.duration) * 100) : 0}%`;
  $('#tcur').textContent = formatTime(position);
}
setInterval(updateProgress, 500);

// ───────────── Configuración (solo streamer) ─────────────
const checkbox = (id, checked, label) => `<label class="row"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}> ${label}</label>`;
const numberField = (id, label, value, min, max) => `<label class="fld">${label}<input type="number" id="${id}" min="${min}" max="${max}" value="${value}"></label>`;

function renderSettings() {
  if (!state.isOwner) {
    $('#cfgbody').innerHTML = '<p class="muted sm">Como mod puedes aprobar, rechazar, reordenar, saltar y añadir canciones. La configuración solo la edita el streamer.</p>';
    configSnapshot = '';
    return;
  }
  const s = state.settings;
  const snapshot = JSON.stringify([s, state.subscribed, state.subError]);
  // # No se redibuja mientras se escribe ni si nada cambió
  if (snapshot === configSnapshot || document.activeElement?.closest('#cfgbody')) return;
  configSnapshot = snapshot;

  $('#cfgbody').innerHTML = `
    ${checkbox('c_enabled', s.enabled, 'Peticiones activas')}
    ${checkbox('c_req', s.requireApproval, 'Los espectadores necesitan aprobación de un mod')}
    ${checkbox('c_amod', s.autoApproveMods, 'Las peticiones de mods se aprueban solas')}
    ${checkbox('c_trust', s.trustBadgeMods, 'Dar acceso al panel a quien tenga insignia de mod en tu chat')}
    ${checkbox('c_say', s.chatReplies, 'Responder en el chat (se envía con tu cuenta)')}
    <div class="f2">
      <label class="fld">Comando<input type="text" id="c_cmd" value="${esc(s.command)}"></label>
      ${numberField('c_vol', 'Volumen OBS (0-100)', s.volume, 0, 100)}
      ${numberField('c_mpu', 'Máx. por persona', s.maxPerUser, 1, 50)}
      ${numberField('c_mq', 'Máx. en cola', s.maxQueue, 1, 200)}
      ${numberField('c_dur', 'Duración máx. (min, 0 = sin límite)', s.maxDurationMin, 0, 600)}
      ${numberField('c_cd', 'Espera entre pedidos (seg)', s.cooldownSec, 0, 600)}
      ${numberField('c_vs', 'Votos para saltar con !voteskip (0 = desactivado)', s.skipVotes || 0, 0, 100)}
    </div>
    <label class="fld">Mods autorizados (usuario de Kick, uno por línea)<textarea id="c_mods" rows="4" placeholder="usuario1&#10;usuario2">${esc(s.mods.join('\n'))}</textarea></label>
    <label class="fld">Usuarios bloqueados (no pueden pedir canciones, uno por línea)<textarea id="c_block" rows="3" placeholder="usuario1&#10;usuario2">${esc((s.blockedUsers || []).join('\n'))}</textarea></label>
    ${state.detectedMods.length ? `<p class="muted sm">Mods detectados por insignia: ${state.detectedMods.map(esc).join(', ')}</p>` : ''}
    ${state.ytSearch ? '' : '<p class="muted sm">Solo se aceptan links de YouTube (el servidor no tiene YOUTUBE_API_KEY, así que tampoco puede leer duraciones ni buscar por nombre).</p>'}
    <div class="btns">
      <button class="btn pri" id="c_save">Guardar</button>
      <button class="btn" id="c_resub">${state.subscribed ? 'Reconectar chat' : 'Conectar chat'}</button>
    </div>
    ${state.subError ? `<p class="sm error-text">Error de Kick: ${esc(state.subError)}</p>` : ''}`;

  $('#c_save').onclick = saveSettings;
  $('#c_resub').onclick = resubscribe;
}

const lines = (selector) => $(selector).value.split(/\r?\n/);

async function saveSettings() {
  try {
    await api('PUT', `/api/c/${channelId}/settings`, {
      enabled: $('#c_enabled').checked,
      requireApproval: $('#c_req').checked,
      autoApproveMods: $('#c_amod').checked,
      trustBadgeMods: $('#c_trust').checked,
      chatReplies: $('#c_say').checked,
      command: $('#c_cmd').value,
      volume: $('#c_vol').value,
      maxPerUser: $('#c_mpu').value,
      maxQueue: $('#c_mq').value,
      maxDurationMin: $('#c_dur').value,
      cooldownSec: $('#c_cd').value,
      skipVotes: $('#c_vs').value,
      blockedUsers: lines('#c_block'),
      mods: lines('#c_mods'),
    });
    toast('Guardado');
    configSnapshot = '';
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

async function resubscribe() {
  try {
    const result = await api('POST', `/api/c/${channelId}/resubscribe`);
    toast(result.ok ? 'Chat conectado' : `Kick respondió: ${result.warn}`);
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

// ───────────── Eventos de la interfaz ─────────────
// # Un solo listener para todos los botones con data-a (aprobar, saltar, mover…)
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-a]');
  if (button) act({ type: button.dataset.a, id: button.dataset.id, dir: Number(button.dataset.dir) || undefined });
});

// # Barra de progreso clicable y volumen de OBS
$('#np').addEventListener('click', (e) => {
  const seek = e.target.closest('#seek');
  const duration = state?.playback.song?.duration;
  if (!seek || !duration) return;
  const rect = seek.getBoundingClientRect();
  act({ type: 'seek', seconds: ((e.clientX - rect.left) / rect.width) * duration });
});
$('#np').addEventListener('change', (e) => {
  if (e.target.id === 'vol') act({ type: 'volume', value: Number(e.target.value) });
});

$('#apall').onclick = () => act({ type: 'approveAll' });
$('#clrp').onclick = () => confirm('¿Rechazar todas las pendientes?') && act({ type: 'clearPending' });
$('#shuf').onclick = () => act({ type: 'shuffle' });
$('#clrq').onclick = () => confirm('¿Vaciar la cola?') && act({ type: 'clearQueue' });

$('#addbtn').onclick = async () => {
  const url = $('#addurl').value.trim();
  if (!url) return;
  const result = await act({ type: 'add', url });
  if (!result) return;
  toast(result.msg || 'Listo');
  if (result.ok) $('#addurl').value = '';
};
$('#addurl').onkeydown = (e) => e.key === 'Enter' && $('#addbtn').click();

$('#regen').onclick = async () => {
  if (!confirm('Se invalidará el link de OBS actual. ¿Continuar?')) return;
  await api('POST', `/api/c/${channelId}/regen-key`);
  toast('Clave regenerada: actualiza OBS');
};

for (const button of document.querySelectorAll('[data-copy]')) {
  button.onclick = () => {
    const input = $(`#${button.dataset.copy}`);
    input.select();
    navigator.clipboard?.writeText(input.value);
    toast('Copiado');
  };
}

init();

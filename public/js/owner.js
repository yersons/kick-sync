// # Panel del owner: estadísticas, canales, ajustes globales y respaldos
const CONFIRMS = {
  delete: 'Se ELIMINARÁ el canal con su cola e historial. Esta acción no se puede deshacer. ¿Continuar?',
  suspend: '¿Suspender este canal? Dejará de recibir peticiones y su reproductor público se apagará.',
  'regen-key': 'Se invalidará el link de OBS de este canal. ¿Continuar?',
  clear: '¿Vaciar cola y pendientes de este canal?',
  logout: '¿Cerrar las sesiones de este streamer?',
};

let data = null;
let settingsDirty = false; // evita pisar lo que el owner está escribiendo al refrescar

// ───────────── Formatos ─────────────
function timeAgo(timestamp) {
  if (!timestamp) return '—';
  const s = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h ? `${h}h ` : ''}${m}m`;
}

// ───────────── Carga de datos ─────────────
async function load(first) {
  try {
    data = await api('GET', '/api/owner/overview');
  } catch (e) {
    if (e.message === 'no_autenticado') location.href = '/auth/kick/login?next=/owner';
    else if (e.message === 'solo_owner') location.href = '/';
    else toast(`Error: ${e.message}`);
    return;
  }
  render(first);
}

// ───────────── Dibujo ─────────────
function render(first) {
  const { totals, server, meta } = data;
  $('#who').textContent = `${data.me.name} · ID ${data.me.id}`;

  const stats = [
    ['Canales', totals.channels, true], ['Activos', totals.active], ['Suspendidos', totals.suspended], ['Usuarios', totals.users],
    ['Canciones reprod.', totals.played, true], ['Peticiones', totals.requests], ['Conexiones en vivo', server.sse], ['Sesiones', totals.sessions],
  ];
  $('#stats').innerHTML = stats.map(([label, value, highlight]) => `<div class="stat${highlight ? ' hl' : ''}"><b>${value}</b><span>${label}</span></div>`).join('');

  $('#srv').innerHTML = `Uptime: <b>${formatUptime(server.uptimeSec)}</b> · Node ${esc(server.node)} · RAM ${server.rssMB} MB · BD ${server.dbKB} KB<br>
    URL base: ${esc(server.baseUrl)} · YouTube API: ${server.ytKey ? 'activa' : 'sin key'} · Owner por <code>${esc(server.ownerBy)}</code>`;
  $('#bklist').innerHTML = data.backups.length
    ? `Últimos respaldos en <code>data/backups/</code>:<br>${data.backups.map(esc).join('<br>')}`
    : 'Aún no hay respaldos.';
  $('#maintbanner').hidden = !meta.maintenance;

  if (first || !settingsDirty) {
    $('#g_ann').value = meta.announcement;
    $('#g_maint').checked = meta.maintenance;
    $('#g_signups').checked = meta.signupsOpen;
    $('#g_allow').value = meta.allowList.join('\n');
  }

  $('#aud').innerHTML = data.audit.length
    ? data.audit.map((a) => `<div><time>${new Date(a.t).toLocaleString()}</time><span><b>${esc(a.who)}</b> · ${esc(a.action)} ${esc(a.target)}</span></div>`).join('')
    : '<span class="muted">Sin actividad registrada.</span>';
  renderChannels();
}

const pill = (text, cls = '', title = '') => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;
const channelButton = (label, action, id, { cls = '', title = '' } = {}) =>
  `<button class="btn sm ${cls}" data-a="${action}" data-id="${id}"${title ? ` title="${title}"` : ''}>${label}</button>`;

function channelRow(c) {
  const status = c.suspended ? pill('suspendido', 'err') : c.enabled ? pill('activo', 'ok') : pill('desactivado');
  const chat = c.subscribed ? pill('chat ok', 'ok') : pill('chat sin conectar', 'err', c.subError || '');
  const token = c.tokenError ? pill('token', 'err', 'El token del streamer falló: debe volver a iniciar sesión') : '';
  const playing = c.now ? `<span class="eq"><i></i><i></i><i></i><i></i></span> ${esc(c.now)}` : '<span class="muted">—</span>';

  return `<tr>
    <td><b>${esc(c.name)}</b><br><a class="sm" href="/p/${esc(c.slug)}" target="_blank">/p/${esc(c.slug)}</a></td>
    <td>${[status, chat, token].join(' ')}</td>
    <td>${c.queue} / ${c.pending}</td>
    <td class="cell-now">${playing}</td>
    <td>${c.played} / ${c.requests}</td>
    <td class="muted sm">${timeAgo(c.lastActive)}</td>
    <td><div class="acts">
      <a class="btn sm" href="/dashboard?ch=${c.id}">Abrir panel</a>
      ${channelButton(c.suspended ? 'Reactivar' : 'Suspender', c.suspended ? 'unsuspend' : 'suspend', c.id, { cls: 'warn' })}
      ${channelButton('Reconectar chat', 'resubscribe', c.id, { title: 'Reconectar el chat' })}
      ${channelButton('Clave OBS', 'regen-key', c.id, { title: 'Invalida el link de OBS' })}
      ${channelButton('Vaciar', 'clear', c.id, { title: 'Vaciar cola y pendientes' })}
      ${channelButton('Cerrar sesión', 'logout', c.id, { title: 'Cerrar las sesiones del streamer' })}
      ${channelButton('Eliminar', 'delete', c.id, { cls: 'bad', title: 'Eliminar canal' })}
    </div></td>
  </tr>`;
}

function renderChannels() {
  const query = $('#q').value.trim().toLowerCase();
  const list = data.channels.filter((c) => !query || c.name.toLowerCase().includes(query) || c.slug.includes(query));
  $('#chn').textContent = data.channels.length;
  $('#rows').innerHTML = list.length ? list.map(channelRow).join('') : '<tr><td colspan="7" class="muted">Sin canales.</td></tr>';
}

// ───────────── Acciones ─────────────
async function channelAction(action, id) {
  if (CONFIRMS[action] && !confirm(CONFIRMS[action])) return;
  try {
    const result = await api('POST', `/api/owner/channel/${id}/${action}`);
    if (action === 'resubscribe') toast(result.ok ? 'Chat reconectado' : `Kick respondió: ${result.warn}`);
    else if (action === 'logout') toast(`Sesiones cerradas: ${result.closed}`);
    else toast('Hecho');
    load();
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

$('#rows').addEventListener('click', (e) => {
  const button = e.target.closest('[data-a]');
  if (button) channelAction(button.dataset.a, button.dataset.id);
});
$('#q').oninput = renderChannels;

for (const id of ['g_ann', 'g_maint', 'g_signups', 'g_allow']) {
  document.getElementById(id).addEventListener('input', () => (settingsDirty = true));
}

$('#g_save').onclick = async () => {
  try {
    await api('PUT', '/api/owner/settings', {
      announcement: $('#g_ann').value,
      maintenance: $('#g_maint').checked,
      signupsOpen: $('#g_signups').checked,
      allowList: $('#g_allow').value.split(/\r?\n/),
    });
    toast('Ajustes guardados');
    settingsDirty = false;
    load(true);
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
};

$('#bk').onclick = async () => {
  try {
    const result = await api('POST', '/api/owner/backup');
    toast(`Respaldo creado: ${result.name}`);
    load();
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
};

$('#logout').onclick = async () => {
  await api('POST', '/auth/logout');
  location.href = '/';
};

load(true);
setInterval(() => load(false), 10000);

// # Utilidades compartidas por todas las páginas
const $ = (selector) => document.querySelector(selector);

// # Escapa texto antes de insertarlo en HTML (evita XSS)
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// # Segundos -> "m:ss" o "h:mm:ss"
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// # Mensaje flotante de 3.5 s (requiere <div id="toast" hidden>)
let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// # Llamada JSON al servidor; lanza Error con el código de error si falla
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'sync' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// # Recibe el estado del servidor por SSE y calcula el desfase de reloj
function listenState(url, onState) {
  const source = new EventSource(url);
  source.addEventListener('state', (e) => {
    const state = JSON.parse(e.data);
    onState(state, state.serverNow - Date.now());
  });
  return source;
}

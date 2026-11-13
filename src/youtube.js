'use strict';
const { CFG } = require('./config');

const YT_URL_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|embed\/|shorts\/|live\/|v\/)|music\.youtube\.com\/watch\?(?:[^\s]*&)?v=)([A-Za-z0-9_-]{11})/;

const ERR_NOT_FOUND = 'El video no existe o es privado.';
const ERR_NOT_EMBEDDABLE = 'Ese video no permite reproducirse fuera de YouTube.';

// # Extrae el ID de 11 caracteres de cualquier link de YouTube
function parseVideoId(text) {
  const match = String(text).match(YT_URL_RE);
  return match ? match[1] : null;
}

// # Convierte una duración ISO 8601 (PT3M25S) a segundos
function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, ok: res.ok, json: await res.json().catch(() => null) };
}

// # Busca por nombre (requiere YOUTUBE_API_KEY); devuelve el ID del primer resultado embebible
async function searchVideo(query) {
  if (!CFG.ytKey) return null;
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=1&q=${encodeURIComponent(query)}&key=${CFG.ytKey}`;
  try {
    const { json } = await fetchJson(url, 10000);
    return json?.items?.[0]?.id?.videoId || null;
  } catch {
    return null;
  }
}

// # Datos del video: con API key (duración y embebible) o, si no, vía oEmbed
async function fetchVideoInfo(id) {
  const thumb = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

  if (CFG.ytKey) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}&key=${CFG.ytKey}`;
      const item = (await fetchJson(url, 10000)).json?.items?.[0];
      if (!item) return { error: ERR_NOT_FOUND };
      if (item.status?.embeddable === false) return { error: ERR_NOT_EMBEDDABLE };
      return { title: item.snippet.title, channelTitle: item.snippet.channelTitle, duration: parseDuration(item.contentDetails?.duration), thumb };
    } catch {
      // # Si la API falla se intenta con oEmbed
    }
  }

  try {
    const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
    const { status, ok, json } = await fetchJson(`https://www.youtube.com/oembed?url=${watch}&format=json`, 8000);
    if (status === 401 || status === 403) return { error: ERR_NOT_EMBEDDABLE };
    if (status === 404) return { error: ERR_NOT_FOUND };
    if (ok && json) return { title: json.title, channelTitle: json.author_name, duration: 0, thumb };
  } catch {
    // # Sin red: se acepta con datos mínimos
  }
  return { title: `YouTube ${id}`, channelTitle: '', duration: 0, thumb };
}

module.exports = { parseVideoId, parseDuration, searchVideo, fetchVideoInfo };

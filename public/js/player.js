// # Reproductor sincronizado. Con ?key=... es el "maestro" (OBS): avisa al servidor cuándo termina cada canción
const slug = location.pathname.split('/')[2];
const params = new URLSearchParams(location.search);
const key = params.get('key');
const isMaster = !!key;

if (isMaster) {
  document.documentElement.classList.add('obs');
  if (params.get('overlay') === '1') document.documentElement.classList.add('overlay');
  if (params.get('transparent') === '1') document.documentElement.classList.add('transparent');
}

let state = null; // último estado recibido del servidor
let clockOffset = 0; // servidor - cliente, para sincronizar el segundo exacto
let player = null;
let playerReady = false;
let started = isMaster; // los oyentes deben pulsar "Unirme" (política de autoplay)
let currentSongId = null;
let durationSent = false;
let muted = false;
let endedSongId = null;
let volume = Number(localStorage.getItem('vol') ?? 60);
$('#vol').value = volume;

function notifyServer(kind, body) {
  return fetch(`/api/p/${slug}/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'sync', 'x-player-key': key },
    body: JSON.stringify(body),
  }).catch(() => {});
}

const currentPosition = () => {
  const pb = state.playback;
  return pb.paused ? pb.pausedPos : (Date.now() + clockOffset - pb.startedAt) / 1000;
};

// # YouTube IFrame API
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('yt', {
    width: '100%',
    height: '100%',
    playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, fs: 0, origin: location.origin },
    events: {
      onReady() { playerReady = true; syncPlayer(); },
      onStateChange: onPlayerState,
      onError: (e) => { if (isMaster && currentSongId) notifyServer('error', { songId: currentSongId, code: e.data }); },
    },
  });
};

function onPlayerState(e) {
  if (!state || !currentSongId) return;
  if (e.data === YT.PlayerState.ENDED) {
    endedSongId = currentSongId;
    if (isMaster) notifyServer('ended', { songId: currentSongId });
    syncPlayer();
  }
  // # El maestro informa la duración real si el servidor no la conoce
  if (e.data === YT.PlayerState.PLAYING && isMaster && !durationSent) {
    const duration = player.getDuration();
    if (duration > 0) {
      durationSent = true;
      notifyServer('meta', { songId: currentSongId, duration: Math.round(duration) });
    }
  }
}

function applyVolume() {
  if (!playerReady) return;
  player.setVolume(isMaster ? state.volume : volume);
  if (isMaster || !muted) player.unMute();
  else player.mute();
}

function showIdle(text) {
  $('#idle').hidden = false;
  $('#idletxt').textContent = text;
}

// # Alinea el reproductor con el estado del servidor (canción, pausa y posición)
function syncPlayer() {
  if (!state || !playerReady) return;
  const pb = state.playback;

  $('#next').hidden = isMaster || !state.queue.length;
  if (state.queue.length) $('#next').textContent = `Siguiente: ${state.queue[0].title}`;

  if (!pb.song) {
    if (currentSongId) {
      try { player.stopVideo(); } catch {}
      currentSongId = null;
      durationSent = false;
    }
    showIdle(isMaster ? 'Esperando canciones…' : 'Esperando la siguiente canción…');
    $('#bar').hidden = true;
    return;
  }

  $('#idle').hidden = true;
  if (!isMaster) $('#bar').hidden = false;
  $('#ttl').textContent = pb.song.title;
  $('#sub').textContent = `${pb.song.channelTitle} · pedida por ${pb.song.by}`;
  if (!started) {
    $('#gate').hidden = false;
    return;
  }
  $('#gate').hidden = true;

  const position = currentPosition();
  const duration = pb.song.duration || 0;
  // # Si la canción ya terminó pero el servidor aún no avanza, no se reinicia
  if (endedSongId === pb.song.id || (duration && position > duration + 1)) {
    if (currentSongId === pb.song.id) {
      try { player.stopVideo(); } catch {}
    }
    showIdle('Esperando la siguiente canción…');
    return;
  }

  if (pb.song.id !== currentSongId) {
    currentSongId = pb.song.id;
    durationSent = false;
    player.loadVideoById({ videoId: pb.song.videoId, startSeconds: Math.max(0, position) });
    applyVolume();
  }

  const status = player.getPlayerState();
  const isActive = status === YT.PlayerState.PLAYING || status === YT.PlayerState.BUFFERING;
  if (pb.paused) {
    if (isActive) player.pauseVideo();
    if (Math.abs(player.getCurrentTime() - position) > 1) player.seekTo(position, true);
  } else {
    if (!isActive && status !== YT.PlayerState.UNSTARTED) player.playVideo();
    if (Math.abs(player.getCurrentTime() - position) > 2.5) player.seekTo(position, true);
  }
  applyVolume();
}

// # Conexión en tiempo real; si el canal no existe se reintenta cada 10 s
function connect() {
  const source = listenState(`/api/p/${slug}/events`, (newState, offset) => {
    state = newState;
    clockOffset = offset;
    syncPlayer();
  });
  source.onerror = () => {
    $('#idle').hidden = false;
    if (source.readyState === EventSource.CLOSED) {
      $('#idletxt').textContent = 'Este canal no está disponible. Reintentando…';
      setTimeout(connect, 10000);
    } else {
      $('#idletxt').textContent = 'Reconectando…';
    }
  };
}
connect();

// # Corrige desvíos cada 4 s y mueve la barra de progreso
setInterval(() => {
  if (state && playerReady && started && state.playback.song && !state.playback.paused) syncPlayer();
}, 4000);

setInterval(() => {
  const bar = $('#prog i');
  if (!bar || !state?.playback.song || !playerReady) return;
  let duration = state.playback.song.duration || 0;
  if (!duration) {
    try { duration = player.getDuration() || 0; } catch {}
  }
  bar.style.width = duration ? `${Math.min(100, Math.max(0, (currentPosition() / duration) * 100))}%` : '0';
}, 500);

$('#go').onclick = () => { started = true; syncPlayer(); };
$('#vol').oninput = (e) => {
  volume = Number(e.target.value);
  localStorage.setItem('vol', volume);
  muted = false;
  $('#mute').textContent = 'Sonido';
  applyVolume();
};
$('#mute').onclick = () => {
  muted = !muted;
  $('#mute').textContent = muted ? 'Silenciado' : 'Sonido';
  applyVolume();
};

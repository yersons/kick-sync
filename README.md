# Kick Sync

Cola de canciones moderada + reproducción sincronizada para Kick. **Sin dependencias** (solo Node 18+).

**Flujo:** el chat escribe `!sr <link de YouTube>` → la petición llega a *Por revisar* → un mod (o el streamer) la aprueba en el panel → pasa a la cola y suena en el reproductor, sincronizado en OBS y para cualquiera que abra el link público.

**Incluye:** panel del streamer y mods, panel exclusivo del **Owner** (`/owner`), votación para saltar, lista de bloqueados, respaldos automáticos, rate limit y pruebas automáticas.

---

## Inicio rápido (local)

```bash
git clone <url-del-repo> kick-sync
cd kick-sync
cp .env.example .env      # rellena KICK_CLIENT_ID y KICK_CLIENT_SECRET
npm start
```

Abre http://localhost:3000.

### 1. Crea tu app de Kick

En https://kick.com/settings/developer:

| Campo | Valor |
|---|---|
| Redirect URI | `http://localhost:3000/auth/kick/callback` |
| Webhook URL | `http://localhost:3000/webhooks/kick` |
| Webhooks | **Activados** |

El Redirect URI debe ser idéntico a `BASE_URL` + `/auth/kick/callback`. Copia el **Client ID** y el **Client Secret** en tu `.env`.

### 2. Recibir el chat en local

Kick no puede enviar webhooks a `localhost`. Para probar el chat expón tu puerto con un túnel (ngrok, cloudflared…), pon esa URL en `BASE_URL` y úsala también en la app de Kick. El login y el panel funcionan en `localhost` sin túnel.

### 3. Activa tu canal

1. Entra a `/` → **Entrar con Kick** → **Activar en mi canal**.
2. En *Configuración del canal* ajusta comando, límites, mods y bloqueados.
3. **OBS:** fuente *Navegador* con el link privado del panel (`/p/<canal>?key=…`). Opcionales: `&overlay=1` (barra con título) y `&transparent=1`. Ese link avisa cuándo termina cada canción; regéneralo si se filtra.
4. **Comunidad:** `/p/<canal>`: se unen con un clic y van en el mismo segundo que OBS.

---

## Variables de entorno

| Variable | Descripción | Por defecto |
|---|---|---|
| `PORT` / `HOST` | Dónde escucha el servidor | `3000` / `127.0.0.1` |
| `BASE_URL` | URL pública de la app | `http://localhost:3000` |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | Credenciales de tu app de Kick | — |
| `OWNER_ID` | ID numérico de Kick del owner (habilita `/owner`) | — |
| `OWNER_USERNAME` | Alternativa temporal si aún no sabes tu ID | — |
| `YOUTUBE_API_KEY` | Opcional: duración, bloqueo de videos no embebibles y búsqueda por nombre | — |
| `DATA_DIR` | Carpeta de `db.json` y `backups/` | `./data` |
| `BACKUP_KEEP` | Respaldos automáticos que se conservan | `14` |

---

## Panel del Owner

El **Owner** es el dueño de la plataforma, distinto del *streamer* (dueño de un canal) y de los *mods*. Para cualquier otra persona `/owner` responde **404** y `/api/owner/*` responde 403.

1. Con `OWNER_USERNAME=tu_usuario` en el `.env`, inicia sesión en `/dashboard`.
2. Haz clic en tu nombre (arriba a la derecha): copia tu ID de Kick.
3. En el `.env` pon `OWNER_ID=<tu id>` y deja `OWNER_USERNAME=` vacío. Reinicia.
4. Entra a `/owner`.

| Función | Detalle |
|---|---|
| Estadísticas | Canales, activos, suspendidos, usuarios, reproducciones, peticiones, conexiones en vivo, uptime, RAM |
| Gestión de canales | Abrir su panel, suspender/reactivar, reconectar chat, regenerar clave de OBS, vaciar cola, cerrar sesiones, eliminar |
| Anuncio global | Banner en todos los paneles |
| Modo mantenimiento | Ignora el chat de todos los canales |
| Registros | Cierra el alta de streamers nuevos y deja pasar solo a una lista |
| Respaldos | Crear uno ahora, ver los últimos y exportar datos en JSON sin tokens ni claves |
| Registro de actividad | Últimas 100 acciones |

---

## Comandos del chat

| Comando | Quién | Qué hace |
|---|---|---|
| `!sr <link o nombre>` (configurable) | todos | Pide una canción (el nombre solo funciona con `YOUTUBE_API_KEY`) |
| `!undo` | todos | Quita tu última petición |
| `!song` | todos | Dice qué suena ahora |
| `!cola` | todos | Muestra las siguientes 3 canciones |
| `!voteskip` | todos | Vota para saltar (se activa con *Votos para saltar* > 0) |
| `!skip` | mods | Salta la canción |

Los comandos solo responden en el chat si **Responder en el chat** está activo (los mensajes salen con la cuenta del streamer).

---

## Estructura

```
server.js            punto de entrada
src/
  app.js             servidor HTTP, rutas base y tareas periódicas
  config.js          .env y constantes
  db.js              base de datos JSON, respaldos y auditoría
  models.js          forma de los datos (canal, ajustes, reproducción)
  http.js            helpers HTTP, CSRF y rate limit
  auth.js            login OAuth con PKCE y sesiones
  kick.js            cliente de la API de Kick y webhooks firmados
  youtube.js         links, búsqueda y datos de video
  channels.js        permisos (owner, streamer, mods)
  playback.js        cola, reglas de petición y acciones del panel
  realtime.js        estado y eventos en vivo (SSE)
  webhook.js         mensajes del chat y comandos
  routes/            api, channel, player, owner y archivos estáticos
public/              páginas, css/ y js/
deploy/              ejemplos de systemd y nginx
test/smoke.js        pruebas de punta a punta
```

---

## Pruebas

```bash
npm test
```

Arranca el servidor con una base de datos temporal, firma webhooks como lo haría Kick y recorre la cola, permisos, panel owner, respaldos y rate limit.

---

## Producción (Linux con systemd + nginx)

Ejemplo con un dominio `sync.example.com` (cámbialo por el tuyo, y úsalo en `BASE_URL` y en la app de Kick).

```bash
# 1. Node 18+
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 2. Código en /opt/kick-sync (git clone, scp o deploy.ps1)
git clone <url-del-repo> /opt/kick-sync && cd /opt/kick-sync
cp .env.example .env && nano .env        # BASE_URL=https://sync.example.com

# 3. Usuario sin privilegios y permisos
useradd --system --home /opt/kick-sync --shell /usr/sbin/nologin kicksync || true
mkdir -p data && chown -R kicksync:kicksync data && chmod 700 data
chown root:kicksync .env && chmod 640 .env

# 4. Servicio
cp deploy/kick-sync.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kick-sync

# 5. Nginx + HTTPS (edita server_name en el archivo)
cp deploy/nginx-sync.conf /etc/nginx/sites-available/kick-sync
ln -s /etc/nginx/sites-available/kick-sync /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d sync.example.com
```

Dos líneas de nginx son **obligatorias**: `proxy_buffering off` (tiempo real) y `X-Forwarded-For $remote_addr` (para que el rate limit no se pueda falsear).

**Subir cambios desde Windows:** `.\deploy.ps1 -Server usuario@mi-servidor` (nunca sube `.env` ni `data\`). Si cambias `server.js` o `src/` reinicia con `systemctl restart kick-sync`; los cambios en `public/` solo necesitan refrescar el navegador (en OBS: clic derecho en la fuente → *Actualizar caché*).

### Operación diaria

```bash
systemctl status kick-sync --no-pager
journalctl -u kick-sync -f
```

**Respaldos:** al arrancar y cada 6 h se copia `db.json` a `data/backups/`. Para restaurar:

```bash
systemctl stop kick-sync
cp data/backups/db-AAAA-MM-DD-HH-MM.json data/db.json
chown kicksync:kicksync data/db.json && chmod 600 data/db.json
systemctl start kick-sync
```

Si `db.json` se corrompe, el servidor no lo sobrescribe: guarda `db.json.corrupta-<fecha>` y arranca vacío.

---

## Seguridad

OAuth con PKCE, cookie `HttpOnly`/`Secure`, protección CSRF con cabecera propia, firma RSA verificada en cada webhook (ventana de 10 min contra repeticiones), rate limit por IP, comparación de claves en tiempo constante, HTML dinámico escapado, `db.json` con permisos 600 y servicio sin privilegios.

`data/db.json` contiene tokens: no lo subas a git (ya está en `.gitignore`).

## Problemas comunes

| Síntoma | Causa / solución |
|---|---|
| Login: *"Kick rechazó el login"* | Client Secret mal copiado o Redirect URI distinto de `BASE_URL/auth/kick/callback` |
| Panel: *"chat sin conectar"* | Webhooks desactivados, URL equivocada o `BASE_URL` no accesible desde internet. Corrige y pulsa **Reconectar chat** |
| `/owner` da 404 con sesión iniciada | `OWNER_ID` (u `OWNER_USERNAME`) no coincide o no reiniciaste. El log de arranque dice si el panel está activo |
| 502 Bad Gateway | El servicio no corre o el puerto no coincide con nginx |
| `EACCES ... data/db.json` | `chown -R kicksync:kicksync data` |
| El tiempo real va a tirones | Falta `proxy_buffering off;` en nginx |
| *"Los registros están cerrados"* | Lo activó el owner: añade al usuario a la lista o reabre los registros |
| `429 demasiadas_peticiones` | Rate limit (240 req/min por IP). Detrás de nginx revisa `X-Forwarded-For $remote_addr` |
| La canción se corta antes de tiempo | Sin `YOUTUBE_API_KEY` la duración la reporta el reproductor de OBS: mantén la fuente activa |

Sin `YOUTUBE_API_KEY` solo se aceptan links, no se conoce la duración al pedir y no se busca por nombre. Las peticiones sin revisar caducan a las 12 h.

## Licencia

MIT

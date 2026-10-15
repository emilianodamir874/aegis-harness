# aegis-web por tunel de Cloudflare (v7, 2026-10-13)

Acceso al chat de aegis desde cualquier lado por una URL `https://*.trycloudflare.com`,
sin abrir puertos en el router. Mismo esquema que el dashboard de Hermes.

## Como quedo

```
browser (celular / afuera)
   |  https://<algo>.trycloudflare.com
   v
cloudflared (quick tunnel, corre en la PC)  ->  http://127.0.0.1:3788
   v
server.mjs (aegis-web v7)
   |-- sirve app/  (login propio si el pedido viene del tunel)
   |-- /config.js  -> wss://<el mismo host>/acp?token=...
   `-- /acp  (WebSocket) proxy a 127.0.0.1:3284, Origin reescrito a http://127.0.0.1:3788
        v
      aegis serve (ACP)  -> sesiones, proveedores, herramientas
```

Por que asi y no dos tuneles (3788 + 3284):

- Un solo origen publico. El token del backend ya no viaja a un segundo host y el WS es
  `wss` del mismo dominio que la pagina (nada de mixed content ni de `--allowed-origin`
  con la URL del tunel, que cambia en cada reinicio).
- El backend queda escuchando solo en la LAN: el tunel llega por el proxy, con `Origin`
  reescrito a `http://127.0.0.1:3788` (que ya estaba en `--allowed-origin`).
- La LAN no cambio: entrando por `http://192.168.100.34:3788` el cliente sigue conectando
  directo a `ws://192.168.100.34:3284/acp`, sin login.

## La puerta (login)

- `auth.json` (`C:\goose-web\auth.json`) tiene la password. **No** esta en `config.json` ni en
  ningun archivo que se sirva: el server la lee al arrancar.
- Cookie `gw_auth` = `<expiracion>.<HMAC-SHA256(secretKey)>`, `HttpOnly; SameSite=Lax; Secure`
  (Secure solo cuando el pedido viene por https), 30 dias. Se verifica con `timingSafeEqual`.
- Un pedido se considera "del tunel" si trae cabeceras `cf-*` (`cf-connecting-ip`, `cf-ray`) o
  si el Host es un dominio publico (no loopback, no `publicHost`, no IP privada/Tailscale).
  Sin cookie valida: 302 a `/login` para navegacion HTML, 401 JSON para lo demas, y el upgrade
  del WebSocket se corta con 401 (verificado).
- Freno de fuerza bruta: 8 fallos por IP en 60 s -> 429. Todo queda en `logs\auth.log`.
- Si `auth.json` no existe o esta roto, el server **rechaza** el tunel (503) en vez de dejarlo abierto.

## Poner / mantener en marcha

```powershell
# watchdog: pasada unica o residente (cada 60 s)
powershell -NoProfile -ExecutionPolicy Bypass -File C:\goose-web\scripts\goose-web-tunnel-watchdog.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\goose-web\scripts\goose-web-tunnel-watchdog.ps1 -Loop

# tarea programada (al iniciar sesion + repeticion cada 10 min como red de seguridad)
schtasks /Run /TN Aegis_Web_Tunnel
schtasks /Query /TN Aegis_Web_Tunnel /V /FO LIST

# URL publica vigente y credenciales
type C:\goose-web\tunnel-url.txt
type C:\goose-web\tunnel-access.txt
```

El watchdog (idempotente, protegido por mutex global para no duplicarse):

1. si `/healthz` no responde, corre `start-goose-web.ps1` (serve 3284 + server.mjs 3788);
2. si no hay un `cloudflared` con `127.0.0.1:3788` en la linea de comandos, lo relanza
   (`--logfile logs\cloudflared-aegis.log`, `--no-autoupdate`, ventana oculta);
3. extrae la URL del log, la escribe en `tunnel-url.txt` y `tunnel-access.txt` (con la password).

Log: `C:\goose-web\logs\tunnel-watchdog.log` (rota a `.old` al pasar 1 MB).

**La URL cambia** cada vez que cloudflared se reinicia (es un quick tunnel sin cuenta). Despues de
un reboot hay que volver a mirar `tunnel-url.txt`. Si hace falta una URL fija hay que pasar a un
tunnel con nombre (`cloudflared tunnel login` + `tunnel create` + DNS + `config.yml` con dos
ingress), y ahi conviene sumar Cloudflare Access (OTP por mail) en lugar del login propio.

## Verificacion (2026-10-13 07:2x)

`node scripts/goose-web-tunnel-check.mjs [url]` (vive en `C:\aegis-src\ui\desktop\scripts\`, como el
resto de los checks de Playwright). Corre desprendido:

```powershell
Start-Process -FilePath "$env:LOCALAPPDATA\hermes\tools\node-26.7.0-win32-x64\node.exe" `
  -ArgumentList 'scripts/goose-web-tunnel-check.mjs' -WorkingDirectory 'C:\aegis-src\ui\desktop' `
  -RedirectStandardOutput 'C:\goose-web\logs\check-tunnel.out.log' -RedirectStandardError 'C:\goose-web\logs\check-tunnel.err.log'
```

Resultado con el tunel vivo (390x844, Chrome headless):

| Chequeo | Resultado |
| --- | --- |
| `GET /` sin cookie (Accept: html) | 302 -> `/login?next=%2F` |
| `GET /config.js`, `POST /client-log` sin cookie | 401 |
| WebSocket `wss://<tunel>/acp?token=x` sin cookie | rechazado |
| Login con la password | cookie `gw_auth`, app carga |
| Conexion del chat | `Conectado`, `acpUrl = wss://<tunel>/acp?token=...`, `tunnel: true` |
| `session/list` por el tunel | 50 sesiones |
| Replay de una sesion real por el tunel | `20261013_25`, 38 mensajes |
| Errores de JS en consola | 0 |

## Pitfalls

- No exponer `3284` a internet: el backend no tiene login propio, solo la secret key en la URL.
- No cambiar el WS del cliente a `ws://...:3284` cuando se entra por el tunel (mixed content +
  el backend rechaza el Origin publico).
- El proxy `/acp` reescribe `Origin` a `http://127.0.0.1:3788` **a proposito**: si se saca, el
  serve corta el handshake porque el Origin publico no esta en `--allowed-origin`.
- `auth.json` se escribe **sin BOM** (`UTF8Encoding($false)`): `Set-Content -Encoding UTF8` en
  PS 5.1 mete BOM y `JSON.parse` explota (el server ya lo tolera con un `replace`).
- Registrar una tarea programada necesita elevacion (UAC); el watchdog en si no.
- El loop residente y una pasada suelta pueden convivir: el mutex `Global\AegisWebTunnelWatchdog`
  hace que el segundo haga una sola pasada y salga.

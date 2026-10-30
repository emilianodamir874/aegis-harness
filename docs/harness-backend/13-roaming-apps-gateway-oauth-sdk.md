# 13 — Roaming, Apps, Gateway, OAuth, SDK y Download Manager

Piezas de borde del motor. Fecha de relevamiento: 2026-10-29. Todo lo que sigue está leído del
árbol vivo `C:\Aegis-Proyects\src` (rama local `feat/antigravity-provider`), no de documentación.

**Hallazgo transversal:** las seis piezas son herencia de `block/goose` renombrada (commit
`7f394c468 feat(rebrand)` toca las seis; ningún commit posterior local las modifica salvo renombres
de test). Tres de ellas **no están cableadas** a la instancia del operador: `aegis-roaming` no lo
depende nadie, `gateway` no se instancia en ningún binario y `aegis_apps` no lo llama la UI web.

## 0. Estado real por pieza

| pieza | qué es | ¿activo en la instancia? | evidencia |
|---|---|---|---|
| `aegis-roaming` | transporte P2P iroh/QUIC para ACP remoto | **No**. Ningún crate lo declara como dependencia; sólo su propio `Cargo.toml` lo nombra | `rg aegis-roaming` sobre los 25 `Cargo.toml` → 1 hit (él mismo) |
| `aegis_apps` | mini-apps HTML (`ui://apps/*`) servidas por ACP | **No usado por la UI web**. No hay `apps/list` en `web/app/app.js` ni existe `state/config/mcp-apps-cache` | grep de `_aegis/unstable/*` en `app.js` lista 16 métodos, ninguno de apps |
| `gateway` | puente a Telegram (long-poll, pairing) | **No arrancado**. `GatewayManager::new` no tiene ningún llamador fuera del módulo | `rg "gateway::|GatewayManager"` → sólo `aegis/src/gateway/*` |
| `oauth` | OAuth 2.1 + PKCE para MCP servers HTTP | **Sí, activo** (camino de extensiones streamable-http) | `streamable_http.rs:26,344,587,635` |
| `aegis-sdk` / `aegis-sdk-types` | GDK: tipos wire `_aegis/*` + bindings uniffi | **Tipos sí** (los usa el propio `aegis` y `aegis-local-inference`); **bindings uniffi no** (feature apagada) | `crates/aegis/Cargo.toml:170`, `aegis-local-inference/Cargo.toml:37` |
| `aegis-download-manager` | descarga HTTP con reanudación | **Sí**, para modelos GGUF/whisper | `dictation.rs:151-196`, `hf_models.rs:1433-2668` |

---

## 1. Roaming — qué significa acá

No es sincronización de config ni de sesiones. Es **exposición de un agente Aegis por internet como
servidor ACP**, punto a punto, sin abrir puertos: `lib.rs:1-24` lo dice explícito y agrega que el
crate "deliberadamente no sabe nada" del interior del agente — el hosting se inyecta por el trait
`AcpStreamServer` (`node.rs:39-52`).

| pieza | ruta:linea | qué hace |
|---|---|---|
| identidad | `aegis-roaming/src/identity.rs:46-78` | ed25519 persistido en `<config>/roaming_node_key`, hex, 0600, creación serializada con lock lateral + rename atómico. La pública **es** el `EndpointId` de iroh: identidad autocertificada en el handshake QUIC-TLS (`identity.rs:1-9`) |
| tarjeta | `card.rs:28-35`, `card.rs:74-88` | esquema `aegis+roam://`, versión 1, máx 8 KiB, ≤16 relays, ≤512 B por URL. No expira y **no da acceso**: sólo pubkey + URLs de relay + fingerprint para verificación out-of-band |
| allowlist | `trust.rs:21-127` | `TrustBook`: `accept`/`revoke_key`/`is_allowed`, persistido con reemplazo atómico. **No hay bearer token**: el acceso existe sólo por aceptar una clave (`lib.rs:15-17`) |
| transporte | `node.rs:25,139-160` | ALPN propio `aegis-acp/1`; endpoint QUIC de `iroh` con `presets::Minimal` |
| relays | `relay.rs:14-111` | `N0Default` / `Custom` / `Disabled`. Token bearer por relay **sólo sobre https**, si no aborta (`relay.rs:94-100`); los tokens nunca viajan en la tarjeta (`relay.rs:62-67`) |
| handshake | `frame.rs:12-44`, `handshake.rs:24-40`, `node.rs:487-579` | frame JSON con prefijo `u32` LE, techo 64 KiB; `ClientHello{label}` → `HostAck::Accepted{agent_id}` / `Rejected{code}`. Autoriza **antes** de ackear para que "Accepted" sea verdad (`node.rs:496-497`) |
| conflicto / revocación | `node.rs:293-355` | invariante fuerte: revocar cierra conexiones **ya abiertas**. Dos mecanismos: watcher que relee el archivo cada 2 s (`node.rs:34`) y re-chequeo post-registro para cerrar el TOCTOU (`node.rs:521-543`) |
| directorio | `directory.rs:20-232` | `PeerEntry` por peer (label, dirección, agente, first/last seen, connected); persistente o en memoria |

### Flujo host (share)

1. `RoamingNode::bind(RoamingConfig)` levanta el endpoint QUIC con la clave persistida (`node.rs:139`).
2. `wait_online(t)` espera contacto con relay (`node.rs:216`).
3. `node.card()` arma la tarjeta con relays configurados **+ los live** (`node.rs:245-253`).
4. La otra punta hace out-of-band: le pasa su pubkey por un canal humano; el host hace `TrustBook::accept` y guarda (`trust.rs:34-95`).
5. `share(AcpStreamServer)` monta el `Router` en el ALPN y arma el watcher de revocación (`node.rs:198-212`).
6. Por conexión: `accept_bi` → `authorize` (relee allowlist del disco; **falla cerrado** si la lectura falla, `node.rs:602-611`) → ack → registro en `live` → re-check → `server.serve_stream(...)`.

### Flujo cliente (dial)

`node.connect(&card, label)` reconstruye el `EndpointAddr` desde la tarjeta (`card.rs:121`) y
`connect_with_addr` abre el bi-stream, manda hello, lee ack con timeout de 10 s (`node.rs:30`,
`node.rs:390-448`). Devuelve `RoamingClientStream` con `into_futures_io()` listo para
`ByteStreams::new(send, recv)` (`node.rs:465-473`).

### Autenticación, en una línea

Clave pública ed25519 como identidad de transporte + allowlist local por peer. Ni tokens, ni
passwords, ni certificados que caduquen.

### Trampas

- Sin `trust_path` configurado **no hay revocación en vivo**: sólo se consulta el `TrustBook` en memoria (`node.rs:324-327`).
- Con relays `Disabled` y `bind_addr` IPv4, el builder limpia los transports IP para evitar el stall `MultipathNotNegotiated` (`node.rs:146-153`).
- `agent_id` que manda el host es texto no confiable: se sanitiza igual que el label del cliente (`node.rs:410-417`; `sanitize_label` en `node.rs:647-660`).
- El crate está **sin cablear**: no hay subcomando `roam` ni flag en `aegis-serve`. Para usarlo hoy habría que escribir el `AcpStreamServer` que llame `acp::server::serve` y un CLI que lo maneje.
- **WIP sin commitear** en el árbol: `card.rs` y `node.rs` renombran `dial_addr` → `to_endpoint_addr` (`git diff --stat`: 2 archivos, +5/−5). Compila igual, pero está sin commitear.

---

## 2. Apps / app builder

`aegis_apps` no genera binarios: produce **recursos MCP con HTML** (`ui://apps/<nombre>`, mime
`text/html;profile=mcp-app`) que un cliente ACP puede abrir en una ventana propia.

| pieza | ruta:linea | qué hace |
|---|---|---|
| formato | `aegis_apps/app.rs:18-30` | `AegisApp { resource, mcp_servers[], window_props{width,height,resizable}, prd, deletable }` |
| parseo/serialización | `app.rs:38-126` / `app.rs:128-208` | metadata en `<script type="application/ld+json">` con `@type: AegisApp`, contexto `urn:aegis.ai:schema`; el PRD va aparte en `<script type="application/x-aegis-prd">`. Al parsear, **borra** ambos scripts del HTML que sirve (`app.rs:108-109`) |
| descubrimiento MCP | `app.rs:211-302` | recorre los `ui://` del *lease* de extensiones y los convierte en apps; `window` sale de `_meta.window` |
| caché | `aegis_apps/cache.rs:29-40, 99-140` | `<config>/mcp-apps-cache/<ext>_<sha256(ext::uri)>.json`; la app `clock` viene embebida (`cache.rs:10-16`, `clock.html`) y se re-inyecta si falta |
| builder | `agents/platform_extensions/apps.rs:566-602` | extensión `apps` con tools `list_apps`, `create_app`, `iterate_app`, `delete_app`; `create_app`/`iterate_app` generan el HTML con una llamada a un **sub-LLM** (`apps.rs:290-364`, plantillas `apps_create.md` / `apps_iterate.md`) |
| superficie ACP | `aegis-sdk-types/src/custom_requests.rs:170-219` + `acp/server/apps.rs:8-63` | `_aegis/unstable/apps/{list,export,import,delete}` |
| propio de Aegis | `acp/server/apps.rs:100` | reescribe el URI a `ui://apps/<name>` al importar |

Ciclo de vida: `list` sin `session_id` devuelve la caché; con `session_id` junta lo de las
extensiones activas, **purga la caché de esa extensión** y vuelve a guardar (`apps.rs:31-56`).
`deletable` = pertenece a la extensión `apps` y no es el default embebido (`cache.rs:18-27`).

### Trampas

- El HTML de la app es código que corre en una ventana del cliente: de ahí el CSP/permissions por app (`resource.rs:7-71`) y el saneo de nombre a un único componente de archivo (`platform_extensions/apps.rs:245-247, 732-746`, con test que rechaza `ui://apps/legacy/...`).
- La regex de metadata es `(?s)` y codiciosa sobre `</script>` — un HTML con un `</script>` temprano dentro del JSON corta distinto; es parseo por regex, no por parser de HTML (`app.rs:41-51`).
- Nadie consume apps hoy: la UI web no llama `apps/*`, así que `mcp-apps-cache` ni se creó.

---

## 3. Gateway — **no es un proxy HTTP**

Corrección importante para el padre: `aegis/src/gateway/` **no es** un gateway de red ni compite con
el server Node de `C:\Aegis-Proyects\web` (3788/3789). Es un **puente de chat**: expone el agente
en Telegram y no abre ningún puerto.

| pieza | ruta:linea | qué hace |
|---|---|---|
| contrato | `gateway/mod.rs:74-99` | trait `Gateway{start,send_message,validate_config}`; `create_gateway` sólo conoce `"telegram"`, cualquier otro tipo aborta |
| transporte Telegram | `gateway/telegram.rs:13-18, 746-771` | `https://api.telegram.org`, **long-polling** `getUpdates` con timeout 30 s. Sin webhook, sin puerto entrante |
| auth Telegram | `telegram.rs:605-725` | `bot_token` leído de `platform_config` (secreto del store), interpolado en la URL `.../bot<TOKEN>/<method>` |
| pairing | `gateway/pairing.rs:11-27, 78-95` | `PairingState::{Unpaired, PendingCode{code,expires_at}, Paired{session_id,paired_at}}`; códigos pendientes en **secreto** (`gateway_pending_codes`), con revocación explícita de los que quedaron en config plana (`pairing.rs:135`) |
| allowlist de operador | `gateway/manager.rs:30-59` | `allowed_user_ids` por gateway, guardado en `gateway_configs` (config, sin secretos) |
| supervisor | `gateway/manager.rs:89-209` | `GatewayManager` arranca los configs guardados (`check_auto_start`), expone `GatewayStatus` (running/configured/paired_users/info) |

Quién es proxy de quién, en la instancia real: la UI web (`web/server.mjs:873,1742`) habla
**directo** con `ws://127.0.0.1:3284/acp` del `aegis-serve`, que es el único backend. El gateway no
participa en ese camino y no tiene puerto propio; el único modo en que comparte estado es indirecto:
ambos escriben en el mismo store de config/sesiones.

### Trampas

- `GatewayManager::new` **no tiene llamador**: no hay `GatewayManager` en `aegis-server`, y
  `gateway_configs` no existe en `state/config/config.yaml`, así que hoy no hay bot vivo. El código
  compila dentro del binario y queda inerte.
- El token del bot se interpola en la ruta URL: cualquier log de request que imprima la URL filtra
  el token. En el repo hay un fixture con token falso (`telegram.rs:1172`) — no es un secreto real,
  pero deja el patrón a la vista.
- Límites duros: 4096 caracteres por mensaje con partición (`telegram.rs:15,1125`), voz ≤20 MB
  (`telegram.rs:18`), reintento fijo de 5 s ante error de poll (`telegram.rs:16,1070`).

---

## 4. OAuth

Sólo para **MCP servers HTTP con auth** (no para providers: esos tienen su propio flujo, ver
"Cerca pero no igual").

| pieza | ruta:linea | qué hace |
|---|---|---|
| entrada | `oauth/mod.rs:310-323` | `oauth_flow(url, name, static_client)` → `oauth_flow_with_challenge(..., challenge)` |
| reuso de credenciales | `mod.rs:341-410` | `initialize_from_store`; si no cambió el cliente ni los scopes, refresca y **devuelve sin abrir browser**. Si el refresh falla: avisa, borra credenciales y cae a flujo interactivo |
| refresh | `mod.rs:207-225` | margen de 30 s antes del vencimiento (`REFRESH_BUFFER_SECS`) |
| PKCE / registro | `mod.rs:257-308` | dinamarca: cliente pre-registrado (`StaticOAuthClientConfig`, `mod.rs:148-156`) o `client_metadata_url`; el challenge de scope se une a los scopes ya concedidos (SEP-2350, `mod.rs:283-305`) |
| callback | `mod.rs:417-455` | axum efímero en `127.0.0.1:<puerto>` (`AEGIS_OAUTH_CALLBACK_PORT`, 0 = efímero), ruta `/oauth_callback`; template con autoescape testeado (`mod.rs:554-561`) |
| espera | `mod.rs:119-142`, `mod.rs:28-29` | timeout 300 s (`AEGIS_OAUTH_CALLBACK_TIMEOUT_SECONDS`); guarda también `iss` (RFC 9207, `mod.rs:47-52`) |
| almacenamiento | `oauth/persist.rs:29-90` | secreto `oauth_creds_<name>` en el store de config, con `CredentialStore::{load,save,clear}`; `requested_scopes` se guarda al lado para detectar cambios de configuración |
| disparador | `agents/extension_manager/streamable_http.rs:28-77, 344, 587, 635` | 401/403 con `WWW-Authenticate` al inicializar **o** a mitad de sesión; 403 `insufficient_scope` va directo a re-autorización completa |

Tokens: **no se muestran acá ni se muestran nunca**; viven en el store de secretos (hoy
`state/config/secrets.yaml` + keyring), por nombre de extensión.

Qué pasa si expira a mitad de turno: no hay refresco silencioso dentro de un tool call. La llamada
MCP falla con 401 → `streamable_http.rs` extrae el challenge → `oauth_flow_with_challenge` refresca
o re-autoriza (browser incluido) → se reintenta la conexión. Si el navegador no abre, la URL queda
impresa en stderr y en el log (`mod.rs:77-86`) y el turno queda esperando hasta 300 s.

### Cerca pero no igual (no confundir)

`providers/chatgpt_codex.rs:795-886`, `gemini_oauth.rs:672-776`, `xai_oauth.rs:558-746`,
`huggingface_auth.rs:556`: flujos OAuth **propios de cada provider**, con su refresh
(`chatgpt_codex.rs:588-595` `grant_type=refresh_token` sobre `ISSUER`) y sus tokens cacheados en
config (`state/config/{gemini_oauth,xai_oauth,chatgpt_codex}/` existen en disco). No pasan por
`oauth/mod.rs`.

---

## 5. SDK y sdk-types

Dos capas, con destinos distintos:

- **`aegis-sdk-types`** (3134 líneas): la fuente única de los métodos `_aegis/*` y de las
  notificaciones custom. Es lo que consume el propio harness y lo que un cliente ACP de terceros
  necesita para hablar con `aegis-serve`.
  - requests: `custom_requests.rs` (~200 structs), con método declarado por macro: `_aegis/unstable/apps/list` (`:170`), `session/steer` (`:283`), `tools/call` (`:144`), `config/*`, `defaults/*`, `onboarding/*`. Todo bajo el prefijo `unstable` — **contrato no congelado**.
  - recipes y schedules: `custom_requests/recipe.rs:13-414`, `custom_requests/schedule.rs:10-171`.
  - notificaciones: `custom_notifications.rs:11-246` (`AegisSessionUpdate`, `SessionUsageUpdate`, `MessageUsageUpdate`, `StatusMessage`, ...).
- **`aegis-sdk`** (2557 líneas): con `default = []` sólo reexporta los tipos (`lib.rs:13`).
  Con `--features uniffi` compila `cdylib`/`staticlib` y expone el **GDK** a Python y Kotlin:
  `bindings.rs:144-1533` (callback `RequestLogger`, `Provider` con `name/supported_features/
  context_limit/list_models/stream/complete/compact`, `declarative_provider_from_json`,
  `openai_*`, `anthropic_*`, `groq_*`, `databricks*_provider`, `ProviderStream::next_chunk`),
  `observability.rs:26-31` (`ObservabilityHook` con `catch_unwind`).
  Versión `0.1.0-alpha.11`.

Quién los consume hoy:

| consumidor | qué usa | evidencia |
|---|---|---|
| `aegis` (el lib) | `aegis-sdk-types` | `crates/aegis/Cargo.toml:170` |
| `aegis-local-inference` | `aegis-sdk-types` (opcional) | `aegis-local-inference/Cargo.toml:37` |
| `aegis-serve` | indirecto, vía `aegis` | no declara `aegis-sdk` |
| UI web (`web/`) | **nada**: reimplementa los métodos como strings JSON | `web/app/app.js` usa 16 `_aegis/unstable/*` literales |
| ui/desktop | nada (no hay `aegis-sdk` en ningún `package.json`) | grep sobre `ui/**/*.json,*.ts` → 0 |
| bindings uniffi | **nadie**: feature apagada por default, no hay consumidor Python/Kotlin en el workspace | `aegis-sdk/Cargo.toml` `default = []` |

**Comparación con goose** (`gh api repos/block/goose/contents/crates` → `goose-sdk`,
`goose-sdk-types`, `goose-roaming`, `goose-download-manager` existen upstream):

| aspecto | local | upstream |
|---|---|---|
| versión sdk | `0.1.0-alpha.11` | `0.1.0-alpha.13` (upstream 2026-10-23) |
| diferencia funcional | falta lo de alpha.12 (`x-request-id` en respuestas/errores PR #12587; metadata live de modelos y preferencia por Responses API PR #12568) y alpha.13 (bump de deps) | tiene ambos |
| estructura de crate | idéntica salvo nombres (`goose_` → `aegis_`) y `description` | igual |
| `CHANGELOG.md` | **vacío** (sólo el encabezado estándar) | con historial completo |
| scripts de release | `scripts/gdk-release.py` presente; `maven/` ausente localmente | `maven/` presente |
| resto | rebrand + reordenamiento de imports (`7bc1e9b51`, `7f394c468`, `47b4e76b3`) | — |

Consecuencia: el GDK local está **2 releases atrás** y sin changelog, así que cualquier consumidor
externo (Python/Kotlin) que se base en alpha.12/13 no matchea.

---

## 6. Download Manager

Descarga **un archivo o un conjunto de shards secuenciales**, con reanudación real.

| aspecto | respuesta | evidencia |
|---|---|---|
| qué descarga | GGUF de modelos para inferencia local y modelos whisper/ggml de dictado | `aegis-local-inference/src/hf_models.rs:14` (`HF_DOWNLOAD_BASE = https://huggingface.co`), `acp/server/dictation.rs:193-196` |
| de dónde | URL arbitraria + `Authorization: Bearer` opcional (para repos HF gated) | `download-manager/src/lib.rs:177-218, 673-682` |
| verifica hashes | **No.** Sólo compara tamaño: HEAD `content-length` vs bytes en disco; si el `.part` coincide exacto lo promueve, si se pasa lo borra | `lib.rs:446-466` |
| reanuda | **Sí**: archivo `.part` al lado + `Range: bytes=N-`; si el server ignora Range (200) reinicia el archivo y descuenta lo contado; `416` con `.part` completo lo da por bueno; `set_len` corrige desfasajes | `lib.rs:9-16, 474-505, 525-531, 559-568` |
| reintentos | 10, backoff exponencial 2 s → 60 s, cancelable en pausas de 500 ms | `lib.rs:313-332` |
| concurrencia | una descarga por `model_id` (`reserve_download` rechaza duplicados y espera al que está cancelándose) | `lib.rs:126-142, 227-236` |
| progreso | `DownloadProgress{bytes,total,percent,speed_bps,eta_seconds,error,task_exited}` en un `HashMap` global | `lib.rs:53-124, 685-690` |
| limpieza | `cleanup_partial_downloads` borra `.part` huérfanos preservando los registrados | `lib.rs:21-51` |
| quién lo usa | `dictation.rs` (descarga/estado de modelos whisper) y `hf_models.rs` (modelos locales); un solo singleton compartido, con test que lo garantiza | `aegis/src/download_manager.rs:1-13` |

Trampas: sin hash no hay defensa contra un mirror comprometido o un GGUF corrupto que tenga el
tamaño correcto; la única validación de integridad es la que haga el loader después
(`is_downloaded()` también es sólo existencia de archivo, `dictation.rs:210-211`).

---

## 7. Local vs GitHub

| pieza | existe sólo local | atrasado vs `origin/main` / upstream | upstream puro (sólo rebrand) |
|---|---|---|---|
| `crates/aegis-roaming` | — (WIP: `card.rs`, `node.rs` sin commitear) | — | sí, es `goose-roaming` |
| `crates/aegis-download-manager` | — | — | sí, es `goose-download-manager` |
| `crates/aegis-sdk` | changelog vaciado, `maven/` ausente | **sí: alpha.11 vs alpha.13** | cuerpo rebrandeado |
| `crates/aegis-sdk-types` | — | sí (mismo version group) | sí |
| `aegis/src/gateway` | — | — | sí, es `goose/src/gateway` |
| `aegis/src/oauth` | comentarios en español en `mod.rs:25-27` (`CLIENT_METADATA_URL = ""`) | — | casi; toca `code-mode` sólo de refilón |
| `aegis/src/aegis_apps` | — | — | sí, es `goose/src/goose_apps` |

`origin/main` del fork está atrasado (último push 2026-10-09), así que ninguna de estas piezas está
en GitHub del lado de Emiliano salvo lo que arrastró ese push; el árbol local es la única verdad.

---

## 8. Referencias web

- iroh (transporte QUIC/relays): https://iroh.computer
- iroh, docs de relays y address discovery: https://docs.iroh.computer
- OAuth 2.0 PKCE, RFC 7636: https://www.rfc-editor.org/rfc/rfc7636
- OAuth 2.0 Authorization Server Metadata, RFC 8414: https://www.rfc-editor.org/rfc/rfc8414
- OAuth 2.1 (draft, base de la práctica "PKCE obligatorio"): https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1
- Issuer en la respuesta de autorización, RFC 9207: https://www.rfc-editor.org/rfc/rfc9207
- MCP, Authorization (spec que implementa `oauth/mod.rs`): https://modelcontextprotocol.io/specification/draft/basic/authorization
- Telegram Bot API (`getUpdates`, `sendMessage`): https://core.telegram.org/bots/api
- MCP Apps / `ui://` (perfil `text/html;profile=mcp-app`): https://modelcontextprotocol.io
- uniffi-rs: https://github.com/mozilla/uniffi-rs
- goose (upstream del que salen estas piezas): https://github.com/block/goose
- goose-sdk Cargo.toml (para la comparación de versión): https://raw.githubusercontent.com/block/goose/main/crates/goose-sdk/Cargo.toml
- goose-sdk CHANGELOG (alpha.12/13): https://raw.githubusercontent.com/block/goose/main/crates/goose-sdk/CHANGELOG.md
- Docs públicas de goose (no hay página específica de GDK/SDK encontrada con búsqueda web; `goose-docs.ai` es un dominio ajeno al proyecto): https://github.com/block/goose

---

## 9. Huecos, riesgos y deuda técnica

| # | hallazgo | evidencia | impacto |
|---|---|---|---|
| 1 | `aegis-roaming` es código muerto en el producto: nadie lo depende, no hay CLI ni flag | `Cargo.toml` members `crates/*`; 0 dependencias | feature completo sin puerta de entrada; mantenido a mano y ya divergiendo (`dial_addr`→`to_endpoint_addr` sin commitear) |
| 2 | `gateway` (Telegram) también inerte: `GatewayManager::new` sin llamador y sin `gateway_configs` en la config viva | `gateway/manager.rs:96`; `config.yaml` sin la clave | si se quiere el bot hay que escribir el arranque en `aegis-server` |
| 3 | Apps MCP sin consumidor: la UI web no pide `apps/*` y no existe `mcp-apps-cache` | grep `_aegis/unstable/*` en `web/app/app.js`; `Get-ChildItem state\config\mcp-apps-cache` vacío | el "app builder" genera HTML que nadie muestra |
| 4 | GDK 2 releases atrás y `CHANGELOG.md` vacío | alpha.11 local vs alpha.13 upstream | cualquier consumidor Python/Kotlin no matchea; sin changelog no hay forma de saber qué falta sin diffear |
| 5 | Download manager sin verificación de hash | `lib.rs` no importa ningún hasher; sólo `content-length` | GGUF corrupto con tamaño correcto entra al loader |
| 6 | Token de Telegram interpola en la URL | `telegram.rs:725` | un log de request con URL completa filtra el bot token |
| 7 | `oauth` interactivo bloquea el turno hasta 300 s con browser | `mod.rs:28-29, 483-489` | en sesión headless (portable, SSH) el turno queda esperando el timeout |
| 8 | Todo el SDK declara `_aegis/unstable/*` | `custom_requests.rs` | contrato sin garantía; renombrar rompe la UI web, que escribe los strings a mano |

## 10. No verificado

- No corrí `cargo build`/`clippy` ni los tests de `aegis-roaming` (restricción read-only de la sesión): el WIP de `card.rs`/`node.rs` es un rename mecánico y los tests actualizados están en el diff, pero **no lo compilé**.
- No verifiqué si el binario desplegado (`core\bin\aegis-v58.exe`) incluye o no el código de gateway/oauth: lo deduje de dependencias de crate, no de símbolos del ejecutable.
- No probé ningún flujo OAuth real ni el pairing de Telegram (no hay bot configurado en la instancia).
- No verifiqué que `ui/desktop` compile sin `aegis-sdk`; sólo comprobé que no lo referencia.

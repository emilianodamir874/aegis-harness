# 11 — Voz: dictado (STT), inferencia local y TTS (Piper)

**Fecha:** 2026-10-29 · **Alcance:** dictado completo, `aegis-local-inference`, `live_voice`, TTS/local reading del cliente web, estado de Piper.
**Método:** lectura de código con `file:line`, estado en disco y en el store. Donde no corrí una prueba, lo digo.
**Binario de referencia:** `core\bin\aegis-v121.exe` (aegis-serve 1.54.0, commit `660d9ff2c`, features `rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http` según `core\state\last-build.json`).

**Titular:** hay tres sistemas distintos y sólo uno está vivo.

| sistema | quién lo ejecuta | estado hoy |
|---|---|---|
| **TTS/lectura (Piper)** | Node `web/server.mjs` + `web/src/app.ts` | **VIVO y es el camino principal** |
| **Dictado (STT)** | navegador + `aegis-serve` `_aegis/unstable/dictation/transcribe` | **vivo pero roto por compilación**: el cliente pide `provider:'local'`, el modelo GGUF está bajado, pero el binario no compila `local-inference` → siempre "Local inference is not available in this build" |
| **live_voice + aegis-local-inference** | Rust, detrás de features | **dormido**: `local-inference` ausente del build y `live-voice` ni siquiera está expuesta por `aegis-server` |

---

## 1. Mapa de piezas

| archivo:línea | qué hace | quién la llama |
|---|---|---|
| `web/src/app.ts:3606` | `VOICE_PROVIDERS = ['local']` — única opción de dictado en el cliente | `micTranscribe` |
| `web/src/app.ts:3607-3608` | VAD: `VOICE_MIN_MS=450`, `VOICE_MAX_MS=90000`, `VOICE_SILENCE_MS=900`, `VOICE_RMS=0.012`, `VOICE_IDLE_MS=8000` | `micWatch` |
| `web/src/app.ts:3611` | `micSecure()` = `window.isSecureContext` — sin HTTPS no hay micrófono | `micStart` |
| `web/src/app.ts:3613-3625` | `micInsert(txt)`: inserta **en el cursor** del textarea y dispara `input` | `micDeliver` |
| `web/src/app.ts:3650-3692` | `micWatch(stream)`: `AudioContext`+`AnalyserNode`, `fftSize=1024`, RMS cada **100 ms**, corte por silencio, barge-in | `micStart` |
| `web/src/app.ts:3694-3725` | `micTranscribe(blob)`: `blobToWav16k` → base64 → RPC `dictation/transcribe` con `mimeType:'audio/wav'` | `rec.onstop` |
| `web/src/app.ts:3727-3733` | `micDeliver`: manos libres = envía; manual = inserta | `micTranscribe` |
| `web/src/app.ts:3734-3786` | `micStart(opts)`: `getUserMedia` mono + AEC/NS/AGC, `MediaRecorder` `audio/webm;codecs=opus` | botón mic / `audNext` / `readToggle` |
| `web/src/app/audio-wav.ts:51,78` | `DICTADO_SAMPLE_RATE = 16000`; `blobToWav16k(blob)` decodifica webm/opus y reescribe PCM a WAV 16 kHz mono | `micTranscribe` |
| `web/src/app/audio-wav.ts:13-43` | `pcmToWav(samples, sampleRate)`: RIFF a mano (offset 24 = sampleRate, 28 = byte rate) | `blobToWav16k` |
| `web/src/app/audio-wav.ts:56` | `bytesToBase64` (base64 estándar, +33 % de tamaño) | `micTranscribe` |
| `src/crates/aegis/src/acp/server/dictation.rs:19-97` | handler `on_dictation_transcribe`: base64 → bytes → extensión por MIME → provider | dispatch ACP |
| `.../dictation.rs:44` | tope **50 MB** de audio decodificado | ídem |
| `.../dictation.rs:50-60` | tabla MIME→ext: webm/opus, mp4, mp3/mpga, m4a, wav/x-wav; otro → `Unsupported format` | ídem |
| `.../dictation.rs:14-16` | modelos por defecto: `whisper-1` (OpenAI), `whisper-large-v3-turbo` (Groq), `scribe_v1` (ElevenLabs) | `dictation_transcribe_params` |
| `src/crates/aegis/src/dictation/providers.rs:37-45` | enum `DictationProvider`: OpenAI, ElevenLabs, Groq, ModelNative (`"model"`), Local (cfg `local-inference`) | handler |
| `.../providers.rs:58-112` | tabla de proveedores: base_url, endpoint, config_key, `uses_provider_config` | `all_providers()`, `is_configured()` |
| `.../providers.rs:145-170` | `is_configured`: secreto presente / modelo whisper descargado / provider activo resoluble | handler `dictation/config` |
| `.../providers.rs:173-221` | `transcribe_local`: `spawn_blocking` + caché global `LOCAL_TRANSCRIBER` (una instancia por modelo) | handler si `Local` |
| `.../providers.rs:456-493` | `transcribe_with_provider`: multipart `file=audio.<ext>` + `model` + opciones | handler si remoto |
| `.../providers.rs:499-577` | `transcribe_with_model`: chat/completions con `input_audio` base64 (modelo nativo) | handler si `ModelNative` |
| `.../providers.rs:432-454` | `option_fields`: `language`/`language_code` (ElevenLabs), `prompt`, `temperature` | ídem |
| `src/crates/aegis/src/dictation/whisper.rs:64-89` | catálogo GGUF: tiny 40 MB, base 78 MB, small 247 MB, medium 777 MB (oxide-lab en HF) | `available_models()` |
| `.../whisper.rs:92-99` | `local_path()` = `Paths::in_data_dir("models")/<archivo>` | descarga/`is_downloaded` |
| `.../whisper.rs:215-224` | selección de device: CUDA → Metal → CPU | `new_with_tokenizer` |
| `.../whisper.rs:255-259` | carga de pesos: `candle_transformers::quantized_var_builder::VarBuilder::from_gguf` | ídem |
| `.../whisper.rs:316-397` | `transcribe(bytes)`: mel → segmentos de `N_FRAMES` → tokens → `deduplicate_text` | `transcribe_local` |
| `.../whisper.rs:399-426` | `prepare_audio_input`: symphonia → PCM f32 mono → `audio::pcm_to_mel` | `transcribe` |
| `.../whisper.rs:1077-1121` | `resample_audio`: sinc `BlackmanHarris2` a 16 kHz | `decode_audio_simple` |
| `src/crates/aegis/src/live_voice/service.rs:178-260` | `LiveVoiceService`: disponibilidad, reserva de interacción, guard por sesión | `acp/server/live_voice.rs` |
| `.../live_voice/service.rs:218-228` | exige `AegisMode::Auto` y proveedor configurado; si no, `Unavailable` | `provider_for_mode` |
| `.../live_voice/service.rs:28-50` | instrucciones del modelo live: política de interrupción + delegación al agente principal | sesión live |
| `src/crates/aegis-providers/src/openai_live_voice_provider.rs:23` | `OPENAI_LIVE_MODEL = "gpt-live-1"` | `start()` |
| `.../openai_live_voice_provider.rs:60-92` | `start(offer)`: `webrtc(config).negotiate(sdp)` → `WebRtcAnswer` | `LiveVoiceService` |
| `.../openai_live_voice_provider.rs:273-...` | `connect_sideband`: WS paralelo para eventos/ack de delegación | ídem |
| `src/crates/aegis-local-inference/src/llamacpp/mod.rs:10-14` | backend llama.cpp por bindings `llama_cpp_2` (+ `llama_cpp_sys_2`) | `LlamaCppBackend` |
| `.../src/backend.rs:38-45` | trait `LocalInferenceBackend`: `load_model`, `generate` | `lib.rs` |
| `web/src/piper-vivo.ts:6-10` | rutas y constantes: `piper.exe`, `voices`, `tmp/piper-vivo`, IDLE 5 min, TIMEOUT 30 s | módulo |
| `web/src/piper-vivo.ts:30-43` | `listo()`: proceso persistente por (voz, ritmo, ns, nw); mata y relanza si cambia la clave | `piperVivo` |
| `web/src/piper-vivo.ts:46-56` | `piperDespertar()`: calienta modelo + runtime con la frase "Listo." | `server.mjs:739` |
| `web/src/piper-vivo.ts:58-87` | `piperVivo(texto, voz, ritmo)`: escribe por stdin, **sondea el .wav en disco** cada 15 ms, espera tamaño estable | `piperTts` |
| `web/server.mjs:798-860` | ruta `GET /tts?text=&engine=&voice=&rate=&ns=&nw=` | fetch del cliente |
| `web/server.mjs:576-584` | `PIPER_VOZ='es_AR-daniela-high'`, caché 24, texto máx 1200, en vuelo 2, en espera 6 | ídem |
| `web/server.mjs:601-613` | `vozPiperValida`: lista `.onnx` del directorio; cualquier voz desconocida cae a la default | `piperTts` |
| `web/server.mjs:616-643` | `headroomWav`: normaliza pico a 0.84 sin reencodificar | `piperTts` |
| `web/server.mjs:644-662` | `piperTts`: vivo → si falla `piperSuelto` (proceso por frase, 35 s, tope 12 MB) | ruta `/tts` |
| `web/server.mjs:741-774` | `edgeTts` (`msedge-tts`, 5 voces es-*, MP3 24 kHz 48 kbps) con cola serializada | ruta `/tts` si `engine=edge` |
| `web/src/app.ts:6781-6803` | lectura **por chat**: `aegis.readOn.<sid>`, migra el flag global viejo | `readLoad` |
| `web/src/app.ts:6807` | `READ_RATE` = 1.365 (override `localStorage['aegis.ttsRate']`) | `READ.rate` |
| `web/src/app.ts:6826-6878` | cola `AUD`, `audPrefetch` (pide la frase siguiente mientras suena la actual), `audStop` | `readPump`/`readSay` |
| `web/src/app.ts:6901-6956` | `readPump`: extrae **sólo** el bloque "Para escuchar", corta por oración/párrafo, habla en vivo | cada chunk del stream |
| `web/src/app.ts:6958-6961` | `readFlush`: al cerrar turno habla el resto sin punto final | fin de turno |
| `web/src/app.ts:6962-6970` | `readToggle`: enciende/apaga y **pide el micrófono en el gesto** (barge-in) | botón de altavoz |

---

## 2. Flujos paso a paso

### 2.1 Dictado: micrófono → compositor

```
botón mic (o ciclo manos libres)
  └─ micStart()                      app.ts:3734
       guardas: isSecureContext (3736), mediaDevices+MediaRecorder (3737)
       getUserMedia({audio:{channelCount:1, echoCancellation:true,
                            noiseSuppression:true, autoGainControl:true}})   3745
       MediaRecorder(audio/webm;codecs=opus)  ó  default del navegador        3749-3751
       rec.start() SIN timeslice → un solo blob al parar                      3771
       micWatch(stream)                                                       3773
  └─ VAD (setInterval 100 ms)        app.ts:3660-3690
       rms = sqrt(mean(x²)) sobre 1024 muestras float
       umbral 0.012 (0.03 mientras el bot habla: el eco no debe cortar)       3674
       silencio 900 ms tras haber hablado  → micStop()                        3689
       sin voz y auto tras 8000 ms         → micStop(true) = descarta         3670-3671
       techo duro 90 s                     → micStop()                        3667
  └─ rec.onstop                      app.ts:3755-3770
       descarta si MIC.discard | ms < 450                                    3765-3768
  └─ micTranscribe(blob)             app.ts:3694
       blobToWav16k(blob)  →  WAV PCM16 mono 16 kHz en el navegador          3710
       bytesToBase64(wav)                                                     3711
       rpc `_aegis/unstable/dictation/transcribe`
           { audio: <base64>, mimeType: "audio/wav", provider: "local" }      3712
  └─ aegis-serve                     acp/server/dictation.rs:19
       provider=="local" && !cfg(local-inference) → invalid_params
           "Local inference is not available in this build"                   26-30
       BASE64.decode  →  >50 MB rechaza                                       40-48
       mime→ext "wav"                                                         55
       TranscribeOptions::from_config (VOICE_DICTATION_*)                     62
       match provider { Local | ModelNative | remoto }                        64-93
  └─ texto  →  micDeliver             app.ts:3727
       manos libres (MIC.auto): envía el turno
       manual: micInsert(txt) → inserta en selectionStart/End + Event('input')
```

**Formato exacto en el cable:** WAV RIFF PCM16, **16 000 Hz**, mono, byte rate `32000`, base64 estándar; MIME `audio/wav`. Se eligió WAV porque el decodificador local es symphonia, **que no tiene Opus** (`app.ts:3706-3709`): mandar el webm/opus de MediaRecorder moría en `Failed to create audio decoder`, justo en Chrome/Android.

**Latencia del dictado:** no la medí en esta pasada (harness: `core\ops\bench-dictado.mjs`, `web\tools\dictation-probe.mjs`). Lo único cierto del código: el tramo navegador→texto tiene dos costos fijos evitables — la decodificación/resample en el cliente y la inferencia Whisper, que en CPU es ~0,5x–3x tiempo real según modelo (`whisper.rs:69-87`). Del lado servidor hay además un tope de 30 s de request para proveedores HTTP (`providers.rs:15`) y 60 s para model-native (`:495`).

### 2.2 Dictado local (Whisper en Rust) — el camino que hoy no corre

```
transcribe_local(bytes)                        providers.rs:173
  spawn_blocking
    model_id ← config LOCAL_WHISPER_MODEL      (config.yaml:111 = "base")
    get_model(model_id) → local_path()         state\data\models\<archivo>.gguf
    caché global Mutex<Option<(path, transcriber)>>   (:28-30, :186-206)
    WhisperTranscriber::new_with_tokenizer()   whisper.rs:208
      Device: new_cuda(0) → new_metal(0) → Cpu   215-224
      mel filters embebidos (melfilters.bytes / melfilters128.bytes)  242-252
      VarBuilder::from_gguf + quantized_model::Whisper::load          255-259
      tokenizer: <dir>/tokenizer.json si existe, si no el embebido (tokens.json)  290-304
    transcriber.transcribe(bytes)              whisper.rs:316
      decode_audio_simple: symphonia, i8..f64, mezcla a mono (1/n canales)  957-1075
      resample sinc BlackmanHarris2 → 16 kHz                                1077-1121
      tope 50 Mi samples (≈50 MB de audio)                                  50, 1147
      pcm_to_mel → tensor (1, 80, T)                                        407-423
      segmentos de N_FRAMES; reglas de timestamps; detect_repetition         344-369, 540-740
      decode_tokens + deduplicate_text                                     386-396
```

Modelos y memoria: **GGUF cuantizados** (q8_0 / q80) de `oxide-lab/whisper-{tiny,base,small,medium}-GGUF` en HuggingFace (`whisper.rs:64-89`). Peso en disco 40 / 78 / 247 / 777 MB; la memoria residente es la del modelo cuantizado más el mel del segmento, y el modelo **queda cacheado entre pedidos** (`providers.rs:186-206`) — es una carga por proceso, no por frase.

**El artefacto existe; el binario no lo puede usar.** `state\data\models` tiene exactamente dos archivos (listado con `-Force`, 2026-10-29):

| archivo | bytes | fecha |
|---|---|---|
| `whisper-base-q8_0.gguf` | 78 067 328 | 2026-10-23 21:38 |
| `tokenizer.json` | 2 480 466 | 2026-10-23 17:47 |

O sea: alguien ya bajó el modelo `base` y su tokenizer el 23/10 (o sea que `LOCAL_WHISPER_MODEL=base` no es sólo una intención escrita, se ejecutó el flujo de descarga al menos una vez). Con el modelo en su lugar, `is_configured(Local)` daría `true` (`providers.rs:149-155`) y `models/list` lo listaría.

**El único bloqueo que queda es de compilación.** El binario desplegado no lleva `local-inference` (`last-build.json: features = rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http`) y el handler rechaza `local` antes de tocar Whisper (`dictation.rs:26-30`). Es decir: **un rebuild con `-Features rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,local-inference` y un swap pondrían el dictado a funcionar sin bajar nada más** (el tokenizer embebido en el binario también sirve de fallback, `whisper.rs:301-304`).

Config del store: `state\config\config.yaml:111-112` → `LOCAL_WHISPER_MODEL: base`, `LOCAL_WHISPER_LANGUAGE: es`.

### 2.3 TTS: bloque "Para escuchar" → Piper → altavoz

```
stream de tokens del agente
  └─ cada chunk → readPump(key, rawText)          app.ts:6901
       si el modo está apagado → no hace nada     6902
       si es el cierre de debate o hay "plan final" → corta  6904-6905
       raw = readBlock(rawText): SOLO el bloque que abre con
             "## Para escuchar" / "Para leer" / "Lectura en voz alta"   6782-6784, 6911
       sin bloque: manos libres lee todo; fuera de HF sólo prosa ≤1200 chars y sin ```  6913-6918
       avance medido sobre el TEXTO CRUDO (el limpio cambia retroactivo)  6908-6911
       corte: primer trozo en la primera coma (>24) o ~90 chars; luego
              agrupación por oración/párrafo con LIMITE=900              6931-6952
       readClean(trozo) → readSay(trozo)                                  6953-6955
  └─ readSay → AUD.q.push + audNext + audPrefetch  6880-6891
  └─ audNext: new Audio('/tts?...')                6838-6872
  └─ GET /tts  (server.mjs:798)
       auth sólo si viene por túnel (799-803); en LAN va sin auth
       texto > 1200 → 413                                              805-808
       slot: 2 en vuelo, 6 esperando, si no 503 "tts ocupado"           585-598, 820-827
       motor: ?engine= || cfg.ttsEngine || "piper"                      810
       voz:   ?voice=  || cfg.ttsVoice  || es_AR-daniela-high           811
       rate:  ?rate=   || cfg.ttsRate   || 1.05                         812
       piperTts → vozPiperValida (whitelist de *.onnx)                  644-645
                caché en memoria por (modelo, ritmo, ns, nw, texto)     647-649
                piperVivo(...)   si falla → piperSuelto(...)            651-657
                headroomWav(pico→0.84)                                   658
       respuesta: audio/wav, x-aegis-tts-path: vivo|suelto,
                  x-aegis-tts-engine: piper|edge                         845-852
  └─ Piper proceso persistente  piper-vivo.ts:30-87
       spawn(piper.exe -m <voz>.onnx -d tmp/piper-vivo -q
             --length_scale <1/rate> --noise_scale 0.667
             --noise_w 0.8 --sentence_silence 0.12)                     35-37
       stdin.write(texto + "\n")                                         63
       poll 15 ms de *.wav nuevos; estable (60 ms, >1000 B) → leer+unlink  66-78
       timeouts: 30 s → mata el proceso y tira error                       80-82
       serialización: viv.cola (una frase por vez)                        84-86
```

**Voces disponibles** (`core\state\piper\voices`):

| voz | archivo | tamaño | uso |
|---|---|---|---|
| `es_AR-daniela-high` | `es_AR-daniela-high.onnx` | 114 199 011 B (≈109 MiB) | **default** en el server (`server.mjs:576`) y en el cliente (`app.ts:6808`) |
| `es_ES-davefx-medium` | `es_ES-davefx-medium.onnx` | 63 201 294 B (≈60 MiB) | disponible, no referenciada por defecto |

Cada `.onnx` tiene su `.onnx.json` (7 248 y 4 817 B) con el mapping de phonemas. El resto del directorio `bin\piper` es el runtime: `piper.exe` (509 952 B), `onnxruntime.dll` (9,3 MB), `piper_phonemize.dll`, `espeak-ng.dll` y `espeak-ng-data\` (diccionarios; `ru_dict` solo pesa 8,5 MB).

**Números medidos** (comentarios en el propio código, no re-medidos por mí):
- 455 ms por frase corta con el proceso vivo contra 1061 ms arrancando de cero (`piper-vivo.ts:1-2`).
- Primer pedido 1305 ms, siguientes 654 ms; de ahí el calentamiento con "Listo." (`piper-vivo.ts:52-53`).
- ~1 s de arranque de Piper por pedido es la razón de que el cliente agrupe hasta 900 chars y precargue la frase siguiente (`app.ts:6827-6829, 6923-6925`).

### 2.4 Barge-in (interrumpir la voz hablando)

```
si READ_ON y la pestaña está visible → audNext abre el micro    app.ts:6864-6870
micStart({auto:true, barge:true})  →  MIC.barge = true          3741
VAD: umbral sube a 0.03 mientras AUD.playing                    3674
     3 tramas consecutivas sobre el umbral → audStop()          3677-3683
     cualquier trama en silencio reinicia el contador (anti-eco) 3686
adStop: vacía la cola, pausa el audio, AUD.playing=false         6873-6878
```
No depende de manos libres: alcanza con que la lectura esté encendida. Y no hay vuelta a la voz del dispositivo: si el server no responde, la frase se saltea y avisa una vez (`app.ts:6848-6856`).

---

## 3. Invariantes y trampas

1. **El dictado exige contexto seguro.** `micSecure()` = `isSecureContext` (`app.ts:3611`): `http://192.168.x.x:3788` **no** da micrófono; `https://…:3789` o el túnel sí. El texto del error lo dice explícitamente (`3736`).
2. **El audio del dictado se convierte a WAV en el navegador, siempre.** symphonia no decodifica Opus (`app.ts:3706-3709`). Si alguien "optimiza" mandando el webm directo, el dictado local muere en `Failed to create audio decoder`.
3. **El cliente sólo ofrece `local`.** `VOICE_PROVIDERS = ['local']` (`app.ts:3606`): los proveedores remotos existen y están completos en Rust, pero la UI no los pide. Cambiar de proveedor hoy es tocar esa línea.
4. **`ModelNative` no sirve para proveedores Anthropic.** El engine rechaza `input_audio` fuera de OpenAI/Ollama (`providers.rs:606-615`). Con `open_design`/antigravity hay que verificar que el endpoint acepte `input_audio` — **no verificado**.
5. **`local` como string de provider depende del feature.** Con `local-inference` apagado el enum ni siquiera tiene la variante; el handler lo intercepta antes (`dictation.rs:26-30`). El schema ACP sigue listando `local` — el contrato miente.
6. **Piper no es una API: es un proceso con archivos.** `piperVivo` escribe por stdin y **sondea el directorio** cada 15 ms (`piper-vivo.ts:66-78`). Consecuencias: (a) si dos pedidos van en paralelo sobre el mismo proceso, los `.wav` se confunden — por eso hay cola serializada (`:84-86`); (b) un timeout deja el `.wav` a medias en `tmp/piper-vivo` y sólo se limpia al arrancar (`prepararDir`, `:23-28`).
7. **Cambiar voz o ritmo mata el proceso.** La clave incluye `voz|ritmo|ns|nw` (`piper-vivo.ts:31-33`): alternar voces paga el arranque completo cada vez.
8. **Idle de 5 minutos.** El proceso se mata recién en el *siguiente* pedido después de 5 min sin uso (`piper-vivo.ts:60`), no por timer. No hay apagado ordenado al cerrar el server — **no verificado** si queda huérfano.
9. **`/tts` en LAN no pide auth.** La comprobación está condicionada a `tunneled` (`server.mjs:799-803`). Cualquiera en la red puede sintetizar audio (texto ≤1200 chars) y hacer trabajar a Piper.
10. **Texto > 1200 chars = 413**, no truncado (`server.mjs:805-808`). El cliente respeta el límite agrupando (`app.ts:6931`).
11. **Se lee sólo el bloque.** Si el modelo no escribe `## Para escuchar`, fuera de manos libres no se lee nada (o prosa ≤1200 sin código) (`app.ts:6911-6918`). Es una dependencia dura del prompt de sistema.
12. **El modo de lectura es por chat.** `aegis.readOn.<sid>` (`app.ts:6788-6803`); cambiar de chat corta el audio (`6790`). El interruptor global viejo se migra una vez.
13. **El motor de TTS está forzado a Piper en el cliente.** Se borran `aegis.ttsEngine` (si no es `piper`) y `aegis.ttsVoice` (`app.ts:6811-6814`). La ruta `engine=edge` sigue viva en el server: es código muerto que igual puede mandar texto a Microsoft si se llama a mano.
14. **`live_voice` exige `AegisMode::Auto`** (`service.rs:223-227`). En cualquier otro modo responde `Unavailable` aunque el proveedor esté configurado.
15. **`live-voice` no está expuesta como feature de `aegis-server`.** `grep live src/crates/aegis-server/Cargo.toml` no devuelve nada; la feature vive sólo en `aegis` (`Cargo.toml:34` → `aegis-providers/live-websocket`). Es decir: **no hay forma de prenderla con `build.ps1 -Features` hoy**.

---

## 4. Local vs GitHub (block/goose)

`gh api repos/block/goose/contents/crates --jq '.[].name'` (2026-10-29) devuelve `goose`, `goose-acp-macros`, `goose-agent`, `goose-cli`, `goose-context-management`, `goose-download-manager`, **`goose-local-inference`**, `goose-mcp`, `goose-provider-types`, `goose-providers`, `goose-roaming`, `goose-sdk`, `goose-sdk-types`, `goose-test`, `goose-test-support`.

| pieza | upstream goose | aegis local | veredicto |
|---|---|---|---|
| dictado STT | `crates/goose/src/dictation/{mod.rs,providers.rs,whisper.rs,whisper_data}` | `crates/aegis/src/dictation/` (misma estructura + `melfilters*.bytes`, `tokens.json`) | **heredado, sin divergencia estructural** |
| live voice | `crates/goose/src/live_voice/{interaction.rs,interaction/,service.rs,service/,transcript.rs}` | `live_voice/{interaction.rs,service.rs,transcript.rs,tests.rs}` — **sin subdirectorios** | **local aplanó/recortó**; el upstream tiene módulos `interaction/` y `service/` que acá no existen |
| inferencia local | `crates/goose-local-inference/src` (backend, config_resolver, hf_models, huggingface_auth, lib, llamacpp, management, mlx, model, multimodal, native_tool_parsing, paths, prompt_template, prompts, provider_utils, thinking_output, tool_emulation, tool_parsing) | `crates/aegis-local-inference/src`, **mismos 20 nombres de archivo** | **heredado 1:1** |
| `Provider` `local` | sí | sí (`lib.rs:30+`, features `local-inference`, `mlx`, `hf-hub`) | heredado |
| **Piper / TTS / `/tts` / lectura "Para escuchar" / barge-in / VAD del cliente** | **no existe** | `web/server.mjs`, `web/src/piper-vivo.ts`, `web/src/app.ts:6781-6970`, `core\state\piper\` | **100 % local** |
| modelo live | — | `gpt-live-1` hardcodeado (`openai_live_voice_provider.rs:23`) | local (o upstream desactualizado; no verifiqué el valor en goose) |

Traducción: **la voz del harness (dictado + whisper + llama.cpp) es upstream; la voz de la UI (Piper, lectura en vivo, barge-in, VAD, conversión WAV) es propia y no tiene contraparte en `block/goose`.**

---

## 5. Referencias web

| URL | qué se usó | estado |
|---|---|---|
| https://github.com/rhasspy/piper | motor TTS local, "A fast, local neural text to speech system" (verificado por API de GitHub, 2026-10-29) | repo existe; **no verifiqué** si está archivado |
| https://github.com/huggingface/candle/tree/main/candle-examples/whisper | base declarada de `whisper.rs` (`whisper.rs:6-7`) | citado en el código |
| https://huggingface.co/oxide-lab/whisper-base-GGUF | origen del GGUF `base` (`whisper.rs:74`) | no bajado ni verificado |
| https://github.com/ggml-org/llama.cpp | motor detrás de `llama_cpp_2` (`llamacpp/mod.rs:10`) | no verificado en esta pasada |
| https://github.com/rhasspy/piper/blob/master/OHF-Voice | — | **no verificado** (intenté una búsqueda web y el motor devolvió resultados basura; no lo uso) |

No consulté `piper.exe --version` ni la procedencia de las voces: no hay checksum ni pin registrado en el repo (`grep` de checksums sobre `core\state\piper` sin resultados).

---

## 6. Huecos, riesgos y deuda técnica

| # | problema | evidencia | impacto |
|---|---|---|---|
| 1 | **El dictado pide `local` y el binario no lo tiene** → cada intento devuelve `Local inference is not available in this build` | `app.ts:3606` vs `dictation.rs:26-30` + `last-build.json.features` | dictado **no funcional** hoy, salvo rebuild con `local-inference` |
| 2 | **El modelo está, la feature no** | `state\data\models\whisper-base-q8_0.gguf` (78 MB, 23/10) vs `last-build.json.features` | el dictado se arregla con **un rebuild + swap**, sin descargar nada |
| 3 | `config.yaml` apunta a `base` + `es` y hoy nadie lo lee | `config.yaml:111-112` | deuda benigna: la config está lista y espera el binario |
| 4 | **`live-voice` inalcanzable por build** | `aegis/Cargo.toml:34`; `aegis-server/Cargo.toml` sin feature homónima | live voice es código muerto hasta que se exponga la feature y se configure `gpt-live-1` |
| 5 | Dependencia de un `.exe` externo sin versión ni hash | `piper-vivo.ts:6`, `server.mjs:574`; sin checksums | cualquier reemplazo de `piper.exe` cambia el timbre y nadie se entera |
| 6 | **Dos voces, 177 MB** (`daniela-high` 114 MB + `davefx` 63 MB), una sola usada | `core\state\piper\voices` | peso muerto en backups/portables |
| 7 | `tmp/piper-vivo` acumula `.wav` huérfanos si hay timeout | `piper-vivo.ts:23-28` (limpieza sólo al iniciar), `:66-82` | basura en disco proporcional a los fallos |
| 8 | Proceso Piper sin apagado ordenado; idle 5 min sólo al siguiente pedido | `piper-vivo.ts:60` | riesgo de proceso residente indefinido tras cerrar el server (**no verificado**) |
| 9 | `/tts` sin auth en LAN | `server.mjs:799-803` | abuso de CPU/DoS trivial en la red local |
| 10 | Motor `edge` (msedge-tts) todavía ruteable aunque el cliente lo prohibe | `server.mjs:832-840` vs `app.ts:6811-6814` | superficie de salida de texto a Microsoft sin uso legítimo |
| 11 | El parser de "Para escuchar" depende del prompt de sistema | `app.ts:6782-6784`, `6911-6918` | si el modelo cambia el encabezado, la lectura se queda muda sin error visible |
| 12 | Sin pruebas automáticas del camino de voz en Rust que verifiquen el contrato ACP completo | hay unit tests en `whisper.rs:1180-1406` y `providers.rs:1050+`, pero nada end-to-end con audio real | el fallo #1 pasó desapercibido justamente por esto |

### No verificado
- Latencia real de dictado punta a punta (no corrí `bench-dictado.mjs` ni `dictation-probe.mjs`; ambos necesitan un serve con `local-inference`).
- Si `open_design`/antigravity acepta `input_audio` para `provider:'model'` (el informe del 2026-10-15 ya lo marcaba como riesgo #1).
- Si queda un `piper.exe` huérfano al reiniciar `server.mjs`.
- Estado de archivo/archivado de `rhasspy/piper` (la API de GitHub responde, la descripción es la esperada; no consulté `archived`).
- Divergencia línea a línea entre `live_voice` local y el de goose: sólo comparé nombres de archivo.
- Métricas de memoria RSS de Whisper med/medium bajo carga (no hay modelo descargado para medir).

### Delta contra `docs/aegis-voz-informe.md` (2026-10-15)
Aquel informe decía "el backend está ~90 % hecho y **el cliente no tiene una sola línea de voz**". Hoy: botón de mic, VAD por energía, conversión a WAV, barge-in, lectura en vivo del bloque "Para escuchar", caché de TTS y voces Piper — todo eso existe (`app.ts:3601-3790, 6781-6970`; `server.mjs:571-860`). Lo que sigue igual de roto desde entonces es exactamente una cosa: **el dictado no transcribe, porque el proveedor elegido (`local`) no está compilado**.

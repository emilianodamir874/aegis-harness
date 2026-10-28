# Aegis Web — investigación de UI/UX y primera iteración

**Corte:** 2026-10-28. **Ámbito:** cliente web real (`web/app/` servido por Node), fuentes `web/src/`, pruebas y navegador Chromium a 1440×900, 390×844 y 320×844. La captura Brave Android de tabla/teclado del 27/10 está documentada en `aegis-web-goal-progress.md`; **no** se hizo otra prueba con teclado físico en esta iteración. El serve ACP, Node y cloudflared no se reiniciaron.

## 1. Estado de partida y sistema de diseño

| Dimensión | Evidencia | Decisión |
|---|---|---|
| Jerarquía | Chat como centro; sidebar 272 px y transcript 760 px a 1440×900; 3 densidades 760/900/660 px; modo presentación. Capturas antes/después fuera del repo (`C:/Users/Emiliano/backups/ui-ux-20261028-{before,after}`). | No ensanchar la prosa por ocupar pantalla: el ancho libre sirve para revisión contextual o segundo panel, no para renglones inmanejables. |
| Tipografía/color | Tokens `--text` a `--text-4`, terracota y superficies en `app/app.css`; `node tools/contrast-report.mjs`: 15/15 pares del gate pasan, texto tenue sobre lienzo 6.57:1. | Conservar paleta y escala existentes; mantener el modo alto contraste. Verificar contraste de módulos inyectados antes de uniformarlos. |
| Movimiento | `--dur-1/2/3` = 90/160/260 ms, salida/entrada y `prefers-reduced-motion`. `node tools/motion-check.mjs`: 17/17. Antes `.tool` y `.thought` animaban también al reabrir una sesión histórica. | Animar semántica del turno **vivo**, no decorar replay. Opacidad/transform para entrada; evitar animar medidas, posiciones y sombras de cientos de nodos. |
| Móvil | Sin scroll horizontal a 320/390 px; el topbar se reparte en dos filas y el compositor ocupa el fondo. Chip táctil medido 30 px y acción `⋯` 28 px antes de la corrección. | Targets de interacción frecuente ≥44 px por decisión de producto (el mínimo WCAG 2.2 AA es 24×24 CSS px, salvo excepciones); conservar iconos compactos. |
| Rendimiento de carga | `node tools/load-cost.mjs` contra loopback: 10 requests, 95.6 KiB transferidos, transcript listo en 119 ms. Es **una muestra local**, no latencia del túnel ni un percentil. | No revertir bundle inicial único; posponer lazy-loading de paneles (~21 KiB br estimados antes) hasta medir sesiones reales y evitar regresiones del deploy. |
| Observabilidad | ACP y estados de fases, actividad, cambios, Doctor, contador de contexto y objetivo ya existen. `verify-web-deploy` prueba HTML, assets, ACP y dos viewports. | No duplicar paneles ni inferir `terminado` de silencio; dar estado únicamente con evidencia persistente y correlacionada. |

## 2. Cambios ejecutados en esta pasada

| Cambio | Contrato probado |
|---|---|
| Doctor (`src/doctor.ts`, bundle y gate) | El modal bloquea el fondo con `inert` sin pisar el estado previo, atrapa Tab/Shift+Tab, Escape cierra y devuelve el foco al disparador; botón dentro de `.topbar-actions`, foco visible, botones de 44 px en táctil. `doctor-check`: 13/13. En 320/390 px el modal cargado y sus botones quedan dentro del viewport. |
| Bienvenida (`app/index.html`, `src/onboarding.ts`) | Un único grupo de tres acciones orientadas al proyecto; no generar sugerencias invisibles duplicadas. El texto de compactación informa el umbral **sólo** si `usage.autoCompactAt` llegó; no afirma 80 % sin saberlo. |
| Interacción táctil (`app/app.css`) | Chips, acciones de mensaje y cabecera de banda rebobinada medidos en ≥44 px a 320/390 px; sin desborde horizontal. Verificar en un teléfono físico sigue pendiente. |
| Replay (`app/app.css`) | `.tool.in` y `.msg-*.in` animan entradas vivas; nodos históricos, razonamiento y fallos re-reproducidos no animan al montar. `ui-ux-check` mide `animationName` real con fixture de ambas clases y `reducedMotion: reduce` mide ≤1 ms. |
| Gate de navegación (`tests/workspace-nav.ts`) | Retiró expectativas obsoletas sobre selector inferior escondido; abre Actividad/Archivos por cajón, comprueba transcript y scroll preservados, fondo del compositor ante teclado simulado. 1440×900 y 390×844 pasan. |

**Verificación:** `npm run build` (TS + bundles); `npm test` sin `AEGIS_TEST_SMOKE` = 16/16 suites, exit 0 en `C:/Users/Emiliano/backups/ui-ux-20261028-npm-test.log`; `doctor-check` 13/13; `ui-ux-check` 0 fallas; `ui-craft-check` PASS; `motion-check` 17/17; `verify-web-deploy` 12 checks, hash de 3 assets comprimidos, ACP conectado y consola sin errores en ambos viewports. Estos gates no equivalen a un ensayo de teclado Android real, INP del túnel ni consistencia de 1000+ mensajes con tráfico simultáneo.

## 3. Próximas iteraciones priorizadas

| Orden | Problema / oportunidad | Implementación comprobable | Gate de salida |
|---|---|---|---|
| P0 | Tiempo de interacción y movimiento con transcript largo | Perf trace de abrir/cambiar/scroll/stream en sesiones de 400 y 1000+ mensajes; contar long tasks, fps y layout shifts, separar tiempo de `session/load` del render. No agregar `will-change` masivo; si aparecen janks, corregir origen. | p50/p95 de respuesta a click/tecla y frames perdidos comparados A/B bajo el mismo perfil; 0 mensajes perdidos/duplicados, 0 animaciones de replay. |
| P0 | Teclado y paneles en Android real | Captura en Brave/Chrome con teclado cerrado/abierto, visualViewport, foco de input, scroll y selector retirado. | Composer y último mensaje utilizables, sin overlay/scroll horizontal en 320/390 y safe area; grabación + medidas antes/después. |
| P1 (parcial) | Jerarquía de cabecera móvil | De 144 a 104 px: título, Gasto y Objetivos visibles; cinco opciones secundarias bajo «Más», con icono y etiqueta, foco/teclado y targets de 44 px. | `ui-ux-check.mjs` en 320/390 verifica ancho de título 128/198 px, menú en viewport, Doctor, Escape/Home/End y cero desborde. Falta prueba con teclado físico y chips abiertos a la vez. |
| P1 (parcial) | Densidad/espacio en desktop | Selector con 3 opciones, ancla de lectura conservada y persistencia ya implementados; falta interacción en split-view y comparación de tablas/código a 1024/1920 px. | `density-check.mjs` 30/30 a 320/390/1024/1440/1920; faltan capturas de tablas/código y split-view. |
| P1 | Prioridad de información y revisión | En Actividad/Cambios, enlazar evidencia del run al paso y al archivo cuando existe; mostrar explícitamente «sin dato» para pruebas/procedencia, no éxito inventado. | Fixture con cambio, toolCallId, permiso y run final + navegación sin perder scroll; contrato backend persistente antes de mostrar «terminado». |
| P1 | Consistencia gráfica de módulos inyectados | Auditar tokens de estilos embebidos en Doctor/Actividad/Memoria/etc.; sustituir azules/fallbacks y sombras divergentes por tokens CSS compartidos sin afectar las capturas existentes. | Contraste de textos y controles, foco visible, overlay y escalas de espacio en desktop/móvil y alto contraste. |
| P2 | Carga inicial por túnel | Medir caché real y coste de lazy-loading de paneles secundarios; diferir sólo módulos que no tienen botón/estado necesario en el primer paint. | Comparación fría/caliente de bytes, requests y tiempo usable por túnel; todos los paneles funcionan sin 404 ni race al abrir en 3G simulado. |

## 4. Segunda iteración: lectura y rendimiento medidos

| Experimento / mejora | Evidencia | Límite |
|---|---|---|
| Abrir sesión histórica `20261028_13` (1142 mensajes en el índice) | 3 aperturas por viewport autenticado, loopback: mediana 230,1 ms escritorio / 239,4 ms Chromium móvil. Un long task de 89–91 ms / 101–104 ms por apertura; 0 animaciones activas en nodos de replay, 4645 elementos DOM. Datos y capturas fuera del repo en `C:/Users/Emiliano/backups/ui-ux-perf-20261028/`. | El cliente cargó sólo la cola (`state.msgs.size=88`, 229 nodos). No es medición del túnel, dispositivo físico ni carga completa. Long task con navegador headless no explica por sí sola qué función consume tiempo: falta traza de CPU. |
| Historial truncado, acceso oculto | La sesión grande abría con `tailPill=false` pese a 88 bloques pintados y cientos de mensajes omitidos. El cliente infería truncamiento con `state.msgs.size >= 400`, pero esa cifra cuenta tarjetas, no mensajes almacenados. | Arreglo en `src/app.ts`: usar `_meta.replaySkipped` que el server ya devuelve; mostrar cantidad real omitida y botón «Ver historial completo». El gate `tail-history-check.mjs` comprobó `replaySkipped=1870` coincidente con la UI, el salto de 88 a 391 bloques y el segundo `session/load` con `replayTail: 1000000000`; no se hizo una medición de tiempos de esa carga completa. |
| Densidad antes de elegir | Icono cíclico opaco reemplazado por selector «Cómoda / Compacta / Lectura» con vista previa y anchuras reales (760/900/660 px), menú con flechas/Home/End/Escape, etiquetas accesibles y estado persistido. `setDensity` conserva el nodo visible al cambiar a media conversación en lugar de saltar al último mensaje. | `density-check.mjs`: 30/30 en 320, 390, 1024, 1440 y 1920 px con fixture largo; salto visual <1 px en los cinco. No equivale a una sesión activa que reciba streaming mientras el usuario cambia la densidad. |

**Regresión tras publicar:** `npm test` (sin smoke) = 16/16 suites exit 0, log en `C:/Users/Emiliano/backups/ui-ux-20261028-second-test.log`; `density-check.mjs` 30/30; `tail-history-check.mjs` comprueba el `replaySkipped` real y la recuperación; `verify-web-deploy.mjs` comprueba hashes, Node/ACP y render de dos viewports. `node tools/load-cost.mjs` volvió a medir 96,5 KiB loopback (antes 95,6 KiB; mediciones puntuales, no percentiles).

**Traza adicional de una apertura, no un percentil:** CDP/Chromium dejó `C:/Users/Emiliano/backups/ui-ux-perf-20261028/trace-session-20261028_13.json` y `trace-analysis.json`. Entre las marcas `aegis-open-click` y `aegis-open-ready` hubo 307,3 ms con instrumentación; la tarea de hilo principal más larga fue `RunTask` de 112,287 ms. Dentro de esa tarea aparecen callbacks de `requestAnimationFrame` de 36,81 y 33,34 ms y un `Layout` de 28,12 ms. El minificador nombra el callback `Ve` en `bundle.js`: sin mapa de fuentes ni análisis de perfil V8 no se atribuye con certeza a una rutina de `src/app.ts`. Además, en ese trace ya estaba publicada la pastilla de historial (`tailPill=true`), por lo que no es directamente comparable con las seis aperturas previas.

**Prioridad actualizada:** el truncamiento silencioso del historial quedó resuelto por contrato con metadata del backend ya desplegado; el próximo trabajo de rendimiento es obtener un perfil de CPU con source maps e identificar qué lectura de layout cuesta ~28 ms en el tramo medido, antes de modificar el render. El teclado físico y el agrupamiento de acciones del topbar móvil siguen abiertos.

## 5. Tercera iteración: cabecera móvil

| Medida en Chromium móvil | Antes | Después | Resultado |
|---|---:|---:|---|
| Altura de cabecera a 320/390 px | 144/144 px | 104/104 px | 40 px recuperados para el transcript. |
| Ancho de título a 320/390 px | 264/334 px, ocupando una fila sola | 128/198 px, en la misma fila que acciones primarias | Entra el título y se trunca con puntos suspensivos; datos completos accesibles al pulsarlo. |
| Controles del primer renglón | Menú, título y siete iconos en fila aparte | Menú, título, Gasto, Objetivos y «Más» | Los cinco controles secundarios se abren en «Más», con nombre visible y 44 px de alto. |

**Accesibilidad y prueba:** el panel «Más» usa los botones originales (no clones), `aria-expanded`, flechas/Home/End/Escape, restaura foco al cerrar, clampa al `visualViewport` y reubica con el teclado. Doctor sigue recibiendo foco de retorno dentro del menú; Letra devuelve al disparador visible «Más» y Densidad devuelve a su control mientras el menú padre permanece abierto (Escape siguiente lo cierra). `ui-ux-check.mjs` en 320/390 px comprueba posición, cinco acciones de 44 px, navegación, Doctor y ausencia de desborde. El panel de letra se coloca sobre el transcript en móvil y enfoca su rango al abrirse. La geometría previa (144 px) quedó registrada en la medición de Chromium de esta iteración; las capturas `C:/Users/Emiliano/backups/ui-ux-20261028-topbar-before-{320,390}.png` se tomaron **después** de publicar el cambio y no constituyen imágenes del estado anterior. Pendiente: foto real del menú en Android con teclado abierto; no se presenta emulación como evidencia física.

**Regresión:** en la primera pasada integral tras esta iteración, `npm test` sin smoke informó 15/16: `visibility.mjs` falló mientras consultaba el store vivo, sin diagnóstico de excepción en el log del runner; repetido solo dio exit 0. Una pasada integral posterior sobre el último código (`C:/Users/Emiliano/backups/ui-ux-20261028-final-test.log`) informó 16/16 suites OK y «todo verde», sin smoke; su wrapper PowerShell no registró un marcador de exit code legible, por lo que la evidencia es el resumen del runner y no el código de salida del wrapper. `ui-ux-check`, `density-check`, `doctor-check`, `motion-check`, `ui-craft-check` y `verify-web-deploy` pasaron después de corregir los fixtures de los menús móviles.

## 6. Referencias de decisión

- [WAI-ARIA APG: diálogo modal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): foco inicial, Tab/Shift+Tab contenidos, Escape y devolución de foco.
- [WCAG 2.2, SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): tamaño mínimo 24×24 px o separación equivalente; 44 px es nuestra meta de ergonomía táctil, no una afirmación sobre obligación WCAG AA.
- [web.dev: CSS animations de alto rendimiento](https://web.dev/articles/animations-guide): preferir transform y opacity; medir paints/frames y respetar movimiento reducido.
- [web.dev: INP](https://web.dev/articles/optimize-inp): medir la respuesta a interacciones y main thread antes de elegir microanimaciones adicionales.

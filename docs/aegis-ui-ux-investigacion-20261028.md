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
| P1 | Jerarquía de cabecera móvil | Inventariar ancho de título y 6 acciones en 320/390, priorizar comandos principales y agrupar secundarios en una acción «Más» **sin perder teclado, lector ni descubribilidad**. Doctor ya se integra al grupo correcto. | Título legible ≥80 px; todos los comandos accesibles en ≤2 gestos y con etiquetas; 0 solapamientos al abrir chips/teclado. |
| P1 | Densidad/espacio en desktop | Reemplazar ciclo opaco del icono de densidad por un selector con 3 opciones y muestras de medida; preservar selección por sesión y respetar split-view. | Prueba en 1024/1440/1920 px con tablas y bloques de código; salto de foco/scroll nulo al cambiar densidad; valor anunciado al lector. |
| P1 | Prioridad de información y revisión | En Actividad/Cambios, enlazar evidencia del run al paso y al archivo cuando existe; mostrar explícitamente «sin dato» para pruebas/procedencia, no éxito inventado. | Fixture con cambio, toolCallId, permiso y run final + navegación sin perder scroll; contrato backend persistente antes de mostrar «terminado». |
| P1 | Consistencia gráfica de módulos inyectados | Auditar tokens de estilos embebidos en Doctor/Actividad/Memoria/etc.; sustituir azules/fallbacks y sombras divergentes por tokens CSS compartidos sin afectar las capturas existentes. | Contraste de textos y controles, foco visible, overlay y escalas de espacio en desktop/móvil y alto contraste. |
| P2 | Carga inicial por túnel | Medir caché real y coste de lazy-loading de paneles secundarios; diferir sólo módulos que no tienen botón/estado necesario en el primer paint. | Comparación fría/caliente de bytes, requests y tiempo usable por túnel; todos los paneles funcionan sin 404 ni race al abrir en 3G simulado. |

## 4. Referencias de decisión

- [WAI-ARIA APG: diálogo modal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): foco inicial, Tab/Shift+Tab contenidos, Escape y devolución de foco.
- [WCAG 2.2, SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): tamaño mínimo 24×24 px o separación equivalente; 44 px es nuestra meta de ergonomía táctil, no una afirmación sobre obligación WCAG AA.
- [web.dev: CSS animations de alto rendimiento](https://web.dev/articles/animations-guide): preferir transform y opacity; medir paints/frames y respetar movimiento reducido.
- [web.dev: INP](https://web.dev/articles/optimize-inp): medir la respuesta a interacciones y main thread antes de elegir microanimaciones adicionales.

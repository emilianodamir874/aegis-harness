// Punto de entrada único del cliente.
//
// Por qué existe: el HTML cargaba 13 <script> separados. Cloudflare quick tunnel habla
// HTTP/1.1 con el origen (6 conexiones en paralelo) y el TTFB medido desde el operador es de
// 450-630 ms, así que una carga fría pagaba varias tandas de viajes solo en handshakes.
// Con un solo bundle la carga inicial son 2 requests: index + este archivo.
//
// El orden importa y es el mismo que tenían los <script> en el HTML:
// app primero (define window.__aegisWeb y arranca el ACP), después los paneles, que leen ese
// handle desde sus handlers y tienen guardas de readyState para el arranque.
import './app';
import './skills';
import './memory';
import './artifacts';
import './workspace-nav';
import './activity';
import './changes';
import './context-meter';
import './session-mode';
import './palette';
import './onboarding';
import './handoff';
import './split-view';
import './stats';
import './doctor';

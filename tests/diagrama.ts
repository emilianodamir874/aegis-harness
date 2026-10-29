// Diagramas: detección de arte ASCII y grafo declarativo -> SVG. Puro, sin DOM.
import { check, pass } from './lib.js';
import { esAscii, grafoSvg } from '../src/app/diagrama.js';
import { md } from '../src/app/markdown.js';

// --- esAscii ---
check(esAscii('+------+     +------+\n| HTTP | --> | GW   |\n+------+     +------+'), 'cajas con flechas: diagrama');
check(esAscii('┌────┐\n│ db │\n└────┘'), 'caracteres de bloque: diagrama');
check(!esAscii('const a = 1;\nfunction f() { return a; }'), 'codigo real: no es diagrama');
check(!esAscii('una sola linea con -> flecha'), 'una sola linea: no alcanza');
check(esAscii('| col | col |\n|-----|-----|\n| a   | b   |'), 'grilla de pipes: diagrama');

// --- grafoSvg ---
const svg = grafoSvg('A[Cliente] --> B[Proxy]\nB -->|403| C{Auth}\nC -.-> D[Log]');
check(svg.startsWith('<figure class="grafo-lamina"') && svg.includes('<svg class="grafo"'), 'grafo: lienzo con svg de flujo');
check(/marker-end="url\(#grafo-punta-[a-z0-9]+\)"/.test(svg), 'grafo: las aristas llevan punta de flecha');
check(svg.includes('>Cliente<') && svg.includes('>Auth<'), 'grafo: los textos de los nodos salen');
check(svg.includes('es-decision') && svg.includes('<path class="grafo-forma"'), 'grafo: el rombo {Auth} se dibuja como rombo');
check(svg.includes('>403<'), 'grafo: la etiqueta de la arista sale');
check(grafoSvg('solo texto sin aristas') === '', 'sin aristas: no se dibuja nada');
check(grafoSvg('A[uno]\nA[uno]\nA --> A') !== '', 'ciclo de un nodo: no cuelga y dibuja');
const ramificado = grafoSvg('A[Inicio] --> B{Permiso}\nB -->|sí| C[Ejecutar]\nB -->|no| D[Revisar]\nC --> E[Fin]\nD --> E');
check((ramificado.match(/class="grafo-arista"/g) || []).length === 5, 'ramificado: todas las conexiones');
const especial = grafoSvg('A[<script>alert(1)</script>] --> B["<&]');
check(especial === '' || !especial.includes('<script>'), 'entrada inválida no inyecta HTML');
const inyectado = grafoSvg('A[<svg onload=alert(1)>] --> B[Cliente & API]');
check(inyectado.includes('&lt;svg') && !inyectado.includes('<svg onload'), 'etiquetas escapadas dentro del SVG');
check(grafoSvg('A[Cliente] -->|secreto <b>x</b>| B[Servidor]').includes('&lt;b&gt;'), 'etiqueta de arista escapada');
check(grafoSvg('A --> B') !== grafoSvg('C --> D'), 'SVG diferentes para grafos distintos');
const idsA = grafoSvg('A --> B').match(/id="(grafo-punta-[a-z0-9]+)"/)?.[1];
const idsB = grafoSvg('C --> D').match(/id="(grafo-punta-[a-z0-9]+)"/)?.[1];
check(idsA !== idsB, 'cada grafo usa un marker único');
check(grafoSvg('A[texto] --> B[otro]\nB --> A') !== '', 'ciclo completo sin bloqueo');
check(grafoSvg('A[mal] --> B[no]\nB -->|etiqueta sin cierre C') === '', 'grafo inválido vuelve a código plano');

// --- markdown: el fence decide ---
const conDiagrama = md('```\n+----+     +----+\n| UI | --> | API|\n+----+     +----+\n```');
check(conDiagrama.includes('class="diagrama"'), 'fence ascii: se pinta como figura');
check(!conDiagrama.includes('copy-code'), 'fence ascii: sin boton Copiar');
const conCodigo = md('```\nconst x = 1;\nconst y = 2;\n```');
check(conCodigo.includes('copy-code'), 'fence de codigo real: sigue siendo code-wrap');
const conGrafo = md('```grafo\nA[uno] --> B[dos]\n```');
check(conGrafo.includes('<svg class="grafo"'), 'fence grafo: se convierte a svg');
check(!conGrafo.includes('copy-code'), 'fence grafo: sin boton Copiar');
const tabla = md('| a | b |\n|---|---|\n| 1 | 2 |');
check(tabla.includes('<table'), 'las tablas markdown siguen renderizando como tabla');

pass('diagrama');

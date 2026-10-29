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
check(svg.startsWith('<svg class="grafo"'), 'grafo: produce svg con clase grafo');
check(/marker-end="url\(#grafo-punta\)"/.test(svg), 'grafo: las aristas llevan punta de flecha');
check(svg.includes('>Cliente<') && svg.includes('>Auth<'), 'grafo: los textos de los nodos salen');
check(svg.includes('<polygon'), 'grafo: el rombo {Auth} se dibuja como rombo');
check(svg.includes('>403<'), 'grafo: la etiqueta de la arista sale');
check(grafoSvg('solo texto sin aristas') === '', 'sin aristas: no se dibuja nada');
check(grafoSvg('A[uno]\nA[uno]\nA --> A') !== '', 'ciclo de un nodo: no cuelga y dibuja');

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

// Reglas puras de los modos de sesión: derivación desde la lista de tools, párrafos cerrados y
// citas de lectura. Sin DOM, así corre en Node con `node dist-ts/tests/modos.mjs`.
import { check, pass } from './lib.js';
import {
  CINTAS,
  citaDeLectura,
  cortaElStream,
  esToolDeEscritura,
  modoDesdeHerramientas,
  parrafosCerrados,
} from '../src/app/modos.js';

// --- derivación del modo desde el permiso de shell/edit/write -----------------------------
check(modoDesdeHerramientas([]) === 'ejecutar', 'sin tools: ejecutar');
check(
  modoDesdeHerramientas([
    { name: 'developer__write', permission: 'never_allow' },
    { name: 'developer__edit', permission: 'never_allow' },
    { name: 'developer__shell', permission: 'never_allow' },
    { name: 'developer__read_file', permission: 'always_allow' },
  ]) === 'plan',
  'las tres de escritura en never_allow: plan',
);
check(
  modoDesdeHerramientas([
    { name: 'developer__write', permission: 'ask_before' },
    { name: 'developer__read_file', permission: 'always_allow' },
  ]) === 'revisar',
  'ask_before en escritura: revisar',
);
// Un override mixto no puede leerse como permisivo: gana el más restrictivo.
check(
  modoDesdeHerramientas([
    { name: 'write', permission: 'never_allow' },
    { name: 'shell', permission: 'always_allow' },
  ]) === 'plan',
  'mixto con never_allow: plan',
);
check(
  modoDesdeHerramientas([
    { name: 'write', permission: null },
    { name: 'shell', permission: 'always_allow' },
  ]) === 'ejecutar',
  'sin overrides: ejecutar',
);
check(
  modoDesdeHerramientas([{ name: 'developer__read_file', permission: 'never_allow' }]) === 'ejecutar',
  'negar lectura no cambia el modo',
);

// --- escritura reconocida con y sin prefijo de extensión -----------------------------------
check(esToolDeEscritura('write') && esToolDeEscritura('developer__write'), 'write con y sin prefijo');
check(esToolDeEscritura('developer__shell') && esToolDeEscritura('edit'), 'shell y edit son escritura');
check(!esToolDeEscritura('developer__read_file'), 'leer no es escritura');

// --- párrafos cerrados: lo que ya se puede pintar y lo que sigue con pluma ----------------
const dosParrafos = 'Primero cierra.\n\nSegundo sigue';
check(parrafosCerrados(dosParrafos).cerrados === 'Primero cierra.', 'el primer párrafo queda cerrado');
check(parrafosCerrados(dosParrafos).abierto === 'Segundo sigue', 'el segundo sigue abierto');
check(parrafosCerrados('solo una linea').cerrados === '' && parrafosCerrados('solo una linea').abierto === 'solo una linea', 'un párrafo único está abierto');
check(parrafosCerrados('a\n\nb\n\n').abierto === '' && parrafosCerrados('a\n\nb\n\n').cerrados === 'a\n\nb', 'el cierre final deja todo cerrado');
check(parrafosCerrados('').abierto === '' && parrafosCerrados('').cerrados === '', 'texto vacío no rompe');

// --- corte del stream en revisar ----------------------------------------------------------
check(cortaElStream('revisar', 'developer__write', 'pending'), 'revisar corta en escritura pendiente');
check(cortaElStream('revisar', 'shell', 'in_progress'), 'revisar corta también en curso');
check(!cortaElStream('revisar', 'developer__write', 'completed'), 'una escritura terminada no corta');
check(!cortaElStream('revisar', 'developer__read_file', 'pending'), 'leer no corta el stream');
check(!cortaElStream('plan', 'developer__write', 'pending'), 'en plan no hay escrituras que cortar');
check(!cortaElStream('ejecutar', 'developer__write', 'pending'), 'en ejecutar no se corta');

// --- citas de lectura ---------------------------------------------------------------------
check(citaDeLectura('read_file', { path: 'src/app.ts' }) === 'leyó src/app.ts', 'cita de lectura con ruta');
check(citaDeLectura('developer__grep', { pattern: 'foo' }) === 'buscó foo', 'cita de búsqueda con patrón');
check(citaDeLectura('tree', { path: 'crates' }) === 'miró el árbol de crates', 'cita de árbol');
check(citaDeLectura('read_file', undefined) === 'leyó', 'sin payload la cita no inventa sujeto');
check(citaDeLectura('extensionmanager__list_resources', {}) === 'usó list_resources', 'tool desconocida cae al nombre');

// --- cintas -------------------------------------------------------------------------------
check(Object.keys(CINTAS).length === 3, 'tres modos con cinta');
check(CINTAS.plan.texto.startsWith('plan ·'), 'la cinta de plan se anuncia como plan');
check(CINTAS.revisar.texto.includes('tu sí'), 'revisar avisa que espera al operador');
check(CINTAS.ejecutar.texto.includes('permission.yaml'), 'ejecutar nombra la fuente de verdad');

pass('modos');

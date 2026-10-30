// Reglas puras de los modos de sesión: permisos ACP y clasificación de tools.
import { check, pass } from './lib.js';
import {
  CINTAS,
  cortaElStream,
  esToolDeEscritura,
  modoDesdeHerramientas,
  nombreToolDeUpdate,
} from '../src/app/modos.js';

const escritura = [
  { name: 'developer__shell', description: 'Run command', permission: 'always_allow' },
  { name: 'developer__edit', description: 'Edit file', permission: 'always_allow' },
  { name: 'developer__write', description: 'Write file', permission: 'always_allow' },
];

check(modoDesdeHerramientas(undefined) === null, 'respuesta ausente: conservar modo');
check(modoDesdeHerramientas([]) === null, 'lista vacía: no inferir ejecutar');
check(modoDesdeHerramientas([{ name: 'developer__read_file', permission: 'always_allow' }]) === null, 'lista parcial: no inferir modo');
check(modoDesdeHerramientas(escritura) === 'ejecutar', 'tres tools sin overrides: ejecutar');
check(
  modoDesdeHerramientas(escritura.map((tool) => ({ ...tool, permission: 'never_allow' }))) === 'plan',
  'never_allow en las tres tools: plan',
);
check(
  modoDesdeHerramientas(escritura.map((tool) => ({ ...tool, permission: 'ask_before' }))) === 'revisar',
  'ask_before en las tres tools: revisar',
);
check(
  modoDesdeHerramientas([
    { ...escritura[0], permission: 'always_allow' },
    { ...escritura[1], permission: 'ask_before' },
    { ...escritura[2], permission: 'never_allow' },
  ]) === 'plan',
  'mezcla de permisos: prevalece never_allow',
);
check(
  modoDesdeHerramientas([
    { name: 'developer__write', permission: 'ask_before' },
    { name: 'write', permission: 'never_allow' },
    { name: 'developer__shell', permission: 'always_allow' },
    { name: 'developer__edit', permission: 'always_allow' },
  ]) === 'plan',
  'duplicados por nombre corto: prevalece el permiso restrictivo',
);
check(
  modoDesdeHerramientas([...escritura, { name: 'developer__read_file', permission: 'never_allow' }]) === 'ejecutar',
  'permiso de lectura no altera el modo',
);

check(esToolDeEscritura('write') && esToolDeEscritura('developer__write'), 'write reconoce nombre corto y nombre ACP');
check(esToolDeEscritura('developer__shell') && esToolDeEscritura('edit'), 'shell y edit son escritura');
check(!esToolDeEscritura('shell__read_file'), 'una tool de lectura disfrazada no clasifica como escritura');
check(!esToolDeEscritura('developer__read_file'), 'read_file no es escritura');
check(!esToolDeEscritura('read_file__write'), 'un nombre con componente de lectura no se clasifica como escritura');

check(
  nombreToolDeUpdate({ kind: 'running', _meta: { aegis: { toolCall: { toolName: 'developer__write' } } } }) === 'developer__write',
  'nombre ACP prevalece sobre el estado genérico',
);
check(nombreToolDeUpdate({ kind: 'running' }) === '', 'kind running sin metadata no es identidad de tool');
check(nombreToolDeUpdate({ kind: 'developer__edit' }) === 'developer__edit', 'kind específico es fallback válido');
check(nombreToolDeUpdate({ kind: 'tool', rawInput: { command: 'echo x' } }) === 'shell', 'payload de command identifica shell');
check(nombreToolDeUpdate({ kind: 'running', rawInput: { path: 'x', content: 'y' } }) === 'write', 'payload de contenido identifica write');
check(nombreToolDeUpdate({ kind: 'running', rawInput: { path: 'x', oldText: 'a', newText: 'b' } }) === 'edit', 'payload before/after identifica edit');

check(cortaElStream('revisar', 'developer__write', 'pending'), 'revisar marca escritura pendiente');
check(cortaElStream('revisar', 'shell', 'in_progress'), 'revisar marca shell en curso');
check(!cortaElStream('revisar', 'developer__write', 'completed'), 'escritura completada no queda esperando');
check(!cortaElStream('revisar', 'developer__read_file', 'pending'), 'lectura no espera aprobación de escritura');
check(!cortaElStream('plan', 'developer__write', 'pending'), 'plan no marca escritura pendiente como revisar');
check(!cortaElStream('ejecutar', 'developer__write', 'pending'), 'ejecutar no marca espera de revisión');

check(Object.keys(CINTAS).length === 3, 'hay una cinta para cada modo');
check(CINTAS.plan.texto.startsWith('plan ·'), 'la cinta plan explicita el modo');
check(CINTAS.revisar.texto.includes('tu sí'), 'la cinta revisar explicita aprobación');
check(CINTAS.ejecutar.texto.includes('permission.yaml'), 'la cinta ejecutar identifica la fuente de permisos');

pass('modos');

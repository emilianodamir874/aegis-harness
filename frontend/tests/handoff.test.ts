import { describe, expect, it } from 'vitest';
import { buildHandoff, hasSecret } from '../src/domain/handoff';

const transcript = [
  '# Session Export: Origen',
  '',
  '### User:',
  '> Reescribir el cliente web en React manteniendo todas las funciones del actual',
  '',
  '### Assistant:',
  'Decidí usar un store propio porque assistant-ui no cubre los permisos por socket.',
  'Quedó arreglado el batching de notificaciones con rAF.',
  'Falta probar el rewind contra el motor real y medir en móvil.',
  'El token sk-abcdefghijklmnop no debe viajar al handoff.',
  'Próximo: cerrar el CRUD de skills.',
].join('\n');

describe('handoff entre sesiones', () => {
  it('arma objetivo, estado, decisiones y próximos pasos', () => {
    const block = buildHandoff('Origen', transcript);
    expect(block).toContain('## Handoff · Origen');
    expect(block).toContain('### Objetivo');
    expect(block).toContain('Reescribir el cliente web en React');
    expect(block).toContain('### Decisiones');
    expect(block).toContain('Decidí usar un store propio');
    expect(block).toContain('### Próximos pasos');
    expect(block).toContain('Falta probar el rewind');
    expect(block).toContain('Próximo: cerrar el CRUD de skills');
  });

  it('no copia líneas con forma de credencial', () => {
    expect(hasSecret('sk-abcdefghijklmnop')).toBe(true);
    expect(hasSecret('Bearer abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
    expect(hasSecret('una línea normal')).toBe(false);
    expect(buildHandoff('Origen', transcript)).not.toContain('sk-abcdefghijklmnop');
  });

  it('avisa cuando no detecta nada en vez de inventar', () => {
    const block = buildHandoff('', 'texto corto');
    expect(block).toContain('## Handoff · sesión anterior');
    expect(block).toContain('(no detectado: completalo a mano)');
  });
});

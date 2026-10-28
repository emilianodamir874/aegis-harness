import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/render/markdown';
import { formatToolDiff, diffSummary, diffNote } from '../src/render/diff';

describe('markdown', () => {
  it('escapa HTML antes de insertar markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> y **fuerte**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>fuerte</strong>');
  });

  it('convierte tablas con data-label para móvil', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('data-label="a"');
    expect(html).toContain('<td data-label="b">2</td>');
  });

  it('fences con lenguaje y botón de copiar', () => {
    const html = renderMarkdown('```ts\nconst a = 1;\n```');
    expect(html).toContain('class="code-wrap lang"');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('class="copy-code"');
    expect(html).toContain('const a = 1;');
  });

  it('sólo convierte descargas de /dl/ con nombre seguro', () => {
    const ok = renderMarkdown('[plan](/dl/plan.md)');
    expect(ok).toContain('href="/dl/plan.md"');
    const bad = renderMarkdown('[x](/dl/../../etc/passwd)');
    expect(bad).not.toContain('href="/dl/../');
  });

  it('listas, citas y encabezados', () => {
    const html = renderMarkdown('# T\n\n- uno\n- dos\n\n> cita');
    expect(html).toContain('<h3>T</h3>');
    expect(html).toContain('<ul><li>uno</li><li>dos</li></ul>');
    expect(html).toContain('<blockquote>cita</blockquote>');
  });

  it('es idempotente ante texto vacío', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
  });
});

describe('diff', () => {
  it('calcula agregados y removidos', () => {
    const view = formatToolDiff('a\nb\nc', 'a\nx\nc');
    expect(view.added).toBe(1);
    expect(view.removed).toBe(1);
    expect(view.lines.map((line) => line.kind).join('')).toContain('-');
    expect(view.lines.map((line) => line.kind).join('')).toContain('+');
  });

  it('sin versión anterior no inventa conteos', () => {
    const view = formatToolDiff(undefined, 'uno\ndos');
    expect(view.added).toBeNull();
    expect(diffSummary(view, false)).toBe('contenido');
    expect(diffNote(false, false)).toContain('no informó la versión anterior');
  });

  it('recorta contenido gigante sin calcular el diff', () => {
    const huge = 'x'.repeat(200_001);
    const view = formatToolDiff('a', huge);
    expect(view.clipped).toBe(true);
    expect(view.added).toBeNull();
    expect(diffSummary(view, false)).toBe('vista recortada');
  });

  it('marca una solicitud cuando sólo hay contenido nuevo', () => {
    const view = formatToolDiff(undefined, 'nuevo');
    expect(diffSummary(view, true)).toBe('solicitud');
    expect(diffNote(true, false)).toContain('versión anterior no se conoce');
  });
});

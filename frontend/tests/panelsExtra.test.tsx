import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SplitView } from '../src/ui/SplitView';
import { OutboxPanel } from '../src/ui/OutboxPanel';
import { createHarness, type Harness } from './harness';
import type { SessionId } from '../src/domain/ids';

const session = (sessionId: string, title: string, text: string) => ({
  sessionId,
  title,
  activeRunId: null,
  messages: [
    { role: 'user' as const, text: 'hola', messageId: `${sessionId}-1` },
    { role: 'assistant' as const, text, messageId: `${sessionId}-2` },
  ],
});

let harness: Harness | null = null;
afterEach(() => {
  harness?.store.dispose();
  harness = null;
  vi.unstubAllGlobals();
});

describe('split view', () => {
  it('muestra el export de la otra sesión y refresca', async () => {
    const h = createHarness([session('s1', 'Activa', 'respuesta uno'), session('s2', 'Otra', 'respuesta dos')]);
    harness = h;
    await h.connect();
    await h.store.openSession('s1' as SessionId);
    await h.store.refreshSessions();
    await h.flush();
    render(<SplitView open onClose={() => {}} state={h.store.getState()} store={h.store} />);
    await waitFor(() => expect(screen.getByText(/foto del/)).toBeTruthy());
    const cuerpo = document.querySelector('.split-body')?.textContent ?? '';
    expect(cuerpo).toContain('respuesta dos');
    expect(screen.getByLabelText('Sesión de la segunda columna')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refrescar' })).toBeTruthy();
  });

  it('cerrado no dibuja nada', () => {
    const h = createHarness([session('s1', 'Activa', 'x')]);
    harness = h;
    const { container } = render(<SplitView open={false} onClose={() => {}} state={h.store.getState()} store={h.store} />);
    expect(container.querySelector('.split-pane')).toBeNull();
  });
});

describe('galería del outbox', () => {
  const stub = (): void => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.includes('preview=1')) {
        return new Response(
          JSON.stringify({ name: 'informe.md', bytes: 2048, ext: '.md', binary: false, text: '# Título del informe\n\nPárrafo.' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          dir: 'C:/outbox',
          items: [{ name: 'informe.md', bytes: 2048, mtime: '2026-10-28T10:00:00Z', ext: '.md', url: '/dl/informe.md' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  };

  it('lista y previsualiza el markdown elegido', async () => {
    stub();
    render(<OutboxPanel />);
    const boton = await screen.findByRole('button', { name: /informe\.md/ });
    boton.click();
    await waitFor(() => expect(screen.getByText('Título del informe')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Descargar' }).getAttribute('href')).toBe('/dl/informe.md');
  });

  it('informa cuando el endpoint falla', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
    render(<OutboxPanel />);
    await waitFor(() => expect(screen.getByText(/No se pudo leer \/outbox\.json: HTTP 500/)).toBeTruthy());
  });
});

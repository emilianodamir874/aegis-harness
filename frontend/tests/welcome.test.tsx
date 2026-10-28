import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WelcomeCard } from '../src/ui/WelcomeCard';
import { emptyState, reduce } from '../src/domain/reducer';
import { sessionId } from '../src/domain/ids';
import type { AegisStore } from '../src/domain/store';
import type { SessionState } from '../src/domain/types';

const sesion = (usage: SessionState['usage']): SessionState => {
  const state = reduce(emptyState(), {
    type: 'session/open',
    summary: { id: sessionId('w'), title: 'w', updatedAt: null, createdAt: null, messageCount: null, cwd: null, archived: false, running: false },
  });
  const found = state.sessionIndex['w'];
  if (!found) throw new Error('sin sesión');
  return { ...found, usage };
};

afterEach(() => vi.unstubAllGlobals());

const stubJson = (map: Record<string, unknown>): void => {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const body = map[String(input)];
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
};

describe('estado vacío que enseña', () => {
  it('muestra modelo, tarifa, contexto y objetivos con datos reales', async () => {
    stubJson({
      '/prices.json': { 'deepseek/deepseek-v4.1-flash': { input: 0.14, output: 0.28 } },
      '/goals.json': { items: [{ texto: 'reescribir el frontend' }] },
    });
    const store = { request: async () => ({ sources: [{ name: 'aegis-infra-map' }] }) } as unknown as AegisStore;
    render(
      <WelcomeCard
        session={sesion({ used: 1000, limit: 350000, cost: 0.5, inputTokens: 900, outputTokens: 100, autoCompactAt: 280000, modelUsage: [{ model: 'deepseek-v4.1-flash', inputTokens: 900, outputTokens: 100, cost: 0.5 }] })}
        store={store}
      />,
    );
    expect(await screen.findByText('deepseek-v4.1-flash')).toBeTruthy();
    expect(screen.getByText(/entrada \$0\.14 \/ salida \$0\.28/)).toBeTruthy();
    expect(screen.getByText(/350k tok · compacta a 280k tok/)).toBeTruthy();
    expect(screen.getByText(/1 cargadas · ej: aegis-infra-map/)).toBeTruthy();
    expect(screen.getByText('reescribir el frontend')).toBeTruthy();
  });

  it('sin tools/list cae a las skills del store', async () => {
    stubJson({});
    const store = {
      request: async (method: string) => {
        if (method === 'tools/list') throw new Error('-32601: Method not found');
        return { sources: [{ name: 'aegis-infra-map' }, { name: 'web-search' }] };
      },
    } as unknown as AegisStore;
    render(<WelcomeCard session={sesion(null)} store={store} />);
    expect(await screen.findByText(/2 cargadas · ej: aegis-infra-map, web-search/)).toBeTruthy();
  });

  it('sin ningún dato avisa en vez de inventar', async () => {
    stubJson({});
    const store = { request: async () => { throw new Error('-32601'); } } as unknown as AegisStore;
    render(<WelcomeCard session={sesion(null)} store={store} />);
    expect(await screen.findByText(/Todavía no hay turno en esta sesión/)).toBeTruthy();
  });
});

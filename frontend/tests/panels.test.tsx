import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkspacePanel } from '../src/ui/panels';
import type { PanelId } from '../src/ui/panels';
import type { AegisStore } from '../src/domain/store';
import { emptyState } from '../src/domain/reducer';

// Formas copiadas de las respuestas reales de la instancia de prueba (2026-10-28):
// /outbox.json {dir,items[{name,bytes,mtime,ext,url}]}, /memory.json {path,facts[{id,text,…}]},
// /stats.json {daily[{d,calls,cost,…}]}, /doctor.json {gate:{chequeos[{nombre,estado,detalle}]}}.
const payloads: Record<string, unknown> = {
  '/outbox.json': {
    dir: 'C:/Aegis-Proyects/web/outbox',
    items: [{ name: 'informe.html', bytes: 4096, mtime: '2026-10-28T10:00:00Z', ext: '.html', url: '/dl/informe.html' }],
  },
  '/memory.json': {
    path: 'C:/Aegis-Proyects/state/data/memory.db',
    facts: [{ id: 'F-0001', text: 'Prefiere respuestas directas', kind: 'style', tags: ['estilo'], confidence: 0.95, pinned: true, status: 'confirmed' }],
  },
  '/stats.json': {
    days: 19,
    daily: [{ d: '2026-10-28', calls: 12, cost: 0.42, input: 1200, output: 300, cache: 800 }],
    models: [{ model: 'deepseek-v4.1-flash', calls: 12, cost: 0.42 }],
  },
  '/doctor.json': {
    gate: { estado: 'ok', chequeos: [{ nombre: 'store', estado: 'ok', detalle: '541 MB' }] },
    compactacion: { techoTokens: 350000, umbral: 0.8 },
  },
  '/goals.json': {
    generado: '2026-10-28T10:00:00Z',
    items: [{ sid: 'abc', nombre: 'frontend', texto: 'reescribir el cliente', tipo: 'goal', estado: 'activo' }],
  },
};

const store = { request: async () => ({ sources: [{ name: 'aegis-infra-map', description: 'Rutas del harness' }] }) } as unknown as AegisStore;

const renderPanel = (panel: PanelId) =>
  render(<WorkspacePanel panel={panel} onClose={() => {}} state={emptyState()} session={null} store={store} />);

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (): void => {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    const body = payloads[url];
    if (body === undefined) return new Response('{"error":"desconocido"}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
};

describe('paneles contra formas reales', () => {
  it('archivos lista el outbox', async () => {
    stubFetch();
    renderPanel('archivos');
    // El panel de archivos es ahora la galería del outbox: muestra el nombre del archivo en la lista
    // y ofrece la descarga real (/dl/<nombre>) al seleccionarlo.
    expect(await screen.findByRole('button', { name: /informe\.html/ })).toBeTruthy();
  });

  it('memoria muestra los hechos', async () => {
    stubFetch();
    renderPanel('memoria');
    expect(await screen.findByText('Prefiere respuestas directas')).toBeTruthy();
  });

  it('stats prioriza la tabla diaria y no confunde el número de días con un array', async () => {
    stubFetch();
    renderPanel('stats');
    expect(await screen.findByRole('heading', { name: 'daily' })).toBeTruthy();
    expect(screen.getByText('2026-10-28')).toBeTruthy();
  });

  it('doctor entra por la ruta anidada gate.chequeos', async () => {
    stubFetch();
    renderPanel('doctor');
    expect(await screen.findByRole('heading', { name: 'gate.chequeos' })).toBeTruthy();
    expect(screen.getByText('541 MB')).toBeTruthy();
  });

  it('objetivos lista el goal del chat', async () => {
    stubFetch();
    renderPanel('goals');
    expect(await screen.findByText('reescribir el cliente')).toBeTruthy();
  });

  it('skills usa el RPC sources/list', async () => {
    stubFetch();
    renderPanel('skills');
    expect(await screen.findByText('aegis-infra-map')).toBeTruthy();
  });

  it('un endpoint caído se informa sin romper el panel', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"no autorizado"}', { status: 401 }));
    renderPanel('cambios');
    expect(await screen.findByText(/No se pudo leer \/changes\.json: HTTP 401/)).toBeTruthy();
  });
});

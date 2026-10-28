import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';
import { AegisProvider } from '../src/state/context';
import type { AppConfig } from '../src/config';
import { createHarness, type Harness } from './harness';
import type { FixtureSession } from '../src/fixtures/server';

const config: AppConfig = {
  acpUrl: 'ws://fixture/acp',
  cwd: 'C:/lab',
  host: 'fixture',
  version: 'test',
  tunnel: false,
  authed: true,
  defaultProvider: 'test',
  defaultModel: 'test-model',
  defaultEffort: '',
};

const session = (overrides: Partial<FixtureSession> & { sessionId: string }): FixtureSession => ({
  title: overrides.sessionId,
  activeRunId: null,
  messages: [],
  ...overrides,
});

let harness: Harness | null = null;

afterEach(() => {
  cleanup();
  harness?.store.dispose();
  harness?.client.close();
  harness = null;
});

const mount = (sessions: readonly FixtureSession[]): Harness => {
  const h = createHarness(sessions);
  harness = h;
  render(
    <AegisProvider store={h.store} config={config}>
      <App />
    </AegisProvider>,
  );
  return h;
};

describe('UI: shell y transcript', () => {
  it('abre el chat más reciente y pinta el historial con markdown', async () => {
    mount([
      session({
        sessionId: 'ui',
        title: 'Chat de prueba',
        messages: [
          { role: 'user', text: 'pregunta del operador' },
          { role: 'assistant', text: '**respuesta** con `código`' },
        ],
      }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Chat de prueba' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('pregunta del operador')).toBeTruthy());
    expect(screen.getByText('respuesta')).toBeTruthy();
    expect(screen.getByText('código')).toBeTruthy();
    expect(screen.getByRole('log')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Sesiones' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Acciones de Chat de prueba/ })).toBeTruthy();
  });

  it('muestra la tarjeta de permiso y responde al elegir una opción', async () => {
    const h = mount([session({ sessionId: 'perm', title: 'Permisos', messages: [] })]);
    await screen.findByLabelText('Mensaje');
    await waitFor(() => expect(h.lastSocket().connection).not.toBeNull());
    h.server.askPermission('perm', h.lastSocket().connection?.id ?? 0, 777, [
      { optionId: 'allow', name: 'Permitir', kind: 'allow_once' },
      { optionId: 'deny', name: 'Rechazar', kind: 'reject_once' },
    ]);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.getAttribute('aria-label')).toContain('Ejecutar comando');
    fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));
    await waitFor(() => expect(h.store.getState().pendingBySession['perm']).toBe(0));
    expect(h.lastSocket().sent.some((raw) => raw.includes('"optionId":"allow"'))).toBe(true);
  });

  it('el compositor manda el texto con Enter y el turno se refleja', async () => {
    const h = mount([session({ sessionId: 'send', title: 'Enviar', messages: [] })]);
    await screen.findByLabelText('Mensaje');
    const input = (await screen.findByLabelText('Mensaje')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hola desde el test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(h.server.prompts).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('Recibí: hola desde el test')).toBeTruthy());
    expect(input.value).toBe('');
  });

  it('la paleta se abre con Ctrl+Shift+P y filtra comandos', async () => {
    mount([session({ sessionId: 'pal', title: 'Paleta', messages: [] })]);
    await screen.findByLabelText('Mensaje');
    fireEvent.keyDown(document, { key: 'P', ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole('dialog', { name: 'Paleta de comandos' })).toBeTruthy();
    const search = screen.getByLabelText('Buscar comando');
    fireEvent.change(search, { target: { value: 'cambios' } });
    expect(screen.getByRole('option', { name: /Cambios Git/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Nuevo chat/ })).toBeNull();
  });

  it('el panel de contexto explica cuando todavía no hay uso', async () => {
    mount([session({ sessionId: 'ctx', title: 'Contexto', messages: [] })]);
    await screen.findByLabelText('Mensaje');
    fireEvent.keyDown(document, { key: 'P', ctrlKey: true, shiftKey: true });
    fireEvent.change(await screen.findByLabelText('Buscar comando'), { target: { value: 'contexto' } });
    fireEvent.click(screen.getByRole('option', { name: /Contexto y costo/ }));
    expect(await screen.findByText(/Todavía no llegó información de uso/)).toBeTruthy();
  });
});

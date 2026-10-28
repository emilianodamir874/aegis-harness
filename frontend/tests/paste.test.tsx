import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../src/ui/Composer';
import { createHarness, type Harness } from './harness';
import type { SessionId } from '../src/domain/ids';
import type { SessionState } from '../src/domain/types';

let harness: Harness | null = null;
afterEach(() => {
  harness?.store.dispose();
  harness = null;
  vi.unstubAllGlobals();
});

const boot = async (): Promise<{ store: Harness['store']; session: SessionState }> => {
  const h = createHarness([{ sessionId: 'p1', title: 'Chat', activeRunId: null, messages: [] }]);
  harness = h;
  await h.connect();
  await h.store.openSession('p1' as SessionId);
  await h.flush();
  const session = h.store.getState().sessionIndex['p1'];
  if (!session) throw new Error('sin sesión');
  return { store: h.store, session };
};

// jsdom no tiene DataTransfer: un stub con lo mínimo que usa el compositor.
class DataTransferStub {
  readonly items = {
    lista: [] as File[],
    add(archivo: File) {
      this.lista.push(archivo);
    },
  };
  get files(): File[] {
    return this.items.lista;
  }
}

describe('pegar desde el portapapeles', () => {
  it('una imagen pegada queda como adjunto', async () => {
    vi.stubGlobal('DataTransfer', DataTransferStub);
    const { store, session } = await boot();
    render(<Composer store={store} session={session} onNotice={() => {}} />);
    const area = screen.getByLabelText('Mensaje') as HTMLTextAreaElement;
    const archivo = new File([new Uint8Array([137, 80, 78, 71])], 'captura.png', { type: 'image/png' });
    // jsdom no implementa FileReader.readAsDataURL: se resuelve con un dataURL falso.
    class ReaderStub {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.result = 'data:image/png;base64,iVBORw0KGgo=';
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', ReaderStub);
    fireEvent.paste(area, {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => archivo }],
      },
    });
    await waitFor(() => expect(screen.getByText('captura.png')).toBeTruthy());
  });

  it('pegar texto normal no adjunta nada', async () => {
    const { store, session } = await boot();
    render(<Composer store={store} session={session} onNotice={() => {}} />);
    const area = screen.getByLabelText('Mensaje') as HTMLTextAreaElement;
    fireEvent.paste(area, {
      clipboardData: { items: [{ kind: 'string', getAsFile: () => null }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/captura\.png/)).toBeNull();
  });
});

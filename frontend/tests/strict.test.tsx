import { describe, it } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';
import { AegisProvider } from '../src/state/context';
import { createHarness } from './harness';

describe('strict', () => {
  it('monta sin loop', async () => {
    const h = createHarness([
      {
        sessionId: 'a',
        title: 'Chat',
        activeRunId: null,
        messages: [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'respuesta' }],
      },
    ]);
    render(
      <StrictMode>
        <AegisProvider
          store={h.store}
          config={{
            acpUrl: 'ws://x',
            cwd: '.',
            host: 'h',
            version: 'v',
            tunnel: false,
            authed: true,
            defaultProvider: '',
            defaultModel: '',
            defaultEffort: '',
          }}
        >
          <App />
        </AegisProvider>
      </StrictMode>,
    );
    await screen.findByLabelText('Mensaje');
    await waitFor(() => expect(screen.getByText('respuesta')).toBeTruthy());
    console.log('ok nodes', document.querySelectorAll('*').length);
  });
});

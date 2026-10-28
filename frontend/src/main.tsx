import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AegisProvider } from './state/context';
import { AcpClient } from './acp/client';
import { AegisStore } from './domain/store';
import { loadConfig } from './config';
// El sistema visual del cliente actual se reusa tal cual: mismos tokens, contrastes medidos y
// escala tipográfica. styles.css sólo agrega las piezas nuevas.
import '../../app/app.css';
import './styles.css';
// Última capa: layout, densidad y jerarquía. Gana por orden de cascada sobre app.css y styles.css.
import './theme.css';

/**
 * Arranque: configuración inyectada por el server Node, cliente ACP, store y React.
 * El CSS se empaqueta (no se inyecta por JS) para que la primera pintura no dependa del bundle.
 */
async function boot(): Promise<void> {
  const config = await loadConfig();
  const client = new AcpClient({
    url: config.acpUrl,
    onParseError: (raw) => {
      if (import.meta.env.DEV) console.warn('[acp] mensaje ilegible', raw);
    },
  });
  const store = new AegisStore({ client, defaultCwd: config.cwd });

  const container = document.getElementById('root');
  if (!container) throw new Error('falta #root');

  createRoot(container).render(
    <StrictMode>
      <AegisProvider store={store} config={config}>
        <App />
      </AegisProvider>
    </StrictMode>,
  );
}

void boot().catch((error: unknown) => {
  const container = document.getElementById('root');
  if (container) {
    container.textContent = `No se pudo arrancar el cliente: ${error instanceof Error ? error.message : String(error)}`;
  }
});

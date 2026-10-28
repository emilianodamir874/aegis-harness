export interface AppConfig {
  readonly acpUrl: string;
  readonly cwd: string;
  readonly host: string;
  readonly version: string;
  readonly tunnel: boolean;
  readonly authed: boolean;
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly defaultEffort: string;
}

declare global {
  interface Window {
    __AEGIS_APP__?: Partial<AppConfig> & { acpUrl?: string };
  }
}

/** Configuración que inyecta el server Node. No hay defaults inventados: si falta, falla. */
export function readConfig(): AppConfig {
  const raw = window.__AEGIS_APP__;
  if (!raw || typeof raw.acpUrl !== 'string' || raw.acpUrl.length === 0) {
    throw new Error('Falta /config.js (acpUrl). El server Node tiene que servirlo antes del bundle.');
  }
  return {
    acpUrl: raw.acpUrl,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '.',
    host: typeof raw.host === 'string' ? raw.host : location.host,
    version: typeof raw.version === 'string' ? raw.version : 'react',
    tunnel: raw.tunnel === true,
    authed: raw.authed === true,
    defaultProvider: typeof raw.defaultProvider === 'string' ? raw.defaultProvider : '',
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : '',
    defaultEffort: typeof raw.defaultEffort === 'string' ? raw.defaultEffort : '',
  };
}

/** Carga `/config.js` si la página no lo hizo ya. */
export async function loadConfig(): Promise<AppConfig> {
  if (!window.__AEGIS_APP__) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/config.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('no se pudo cargar /config.js'));
      document.head.appendChild(script);
    });
  }
  return applyAcpOverride(readConfig());
}

/**
 * `?acp=proxy` fuerza el WebSocket por el mismo origen (el proxy /acp del server Node), que es el
 * camino del túnel y de https. En pruebas contra otra instancia cambia el Origin y el serve puede
 * rechazarlo; por el proxy el Origin es el correcto.
 */
function applyAcpOverride(config: AppConfig): AppConfig {
  if (new URLSearchParams(location.search).get('acp') !== 'proxy') return config;
  try {
    const token = new URL(config.acpUrl).searchParams.get('token');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return { ...config, acpUrl: `${scheme}//${location.host}/acp${token ? `?token=${encodeURIComponent(token)}` : ''}` };
  } catch {
    return config;
  }
}

/** En desarrollo sin el server Node se puede arrancar contra un ACP directo. */
export function devConfig(): AppConfig {
  const url = new URL('/acp', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    acpUrl: url.toString(),
    cwd: '.',
    host: location.host,
    version: 'dev',
    tunnel: false,
    authed: false,
    defaultProvider: '',
    defaultModel: '',
    defaultEffort: '',
  };
}

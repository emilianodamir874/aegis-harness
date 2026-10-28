import { useEffect, useState } from 'react';
import type { AegisStore } from '../domain/store';
import type { AppState, SessionState } from '../domain/types';
import { Dialog } from './Dialog';
import { OutboxPanel } from './OutboxPanel';
import { SkillsPanel } from './SkillsPanel';

export type PanelId = 'actividad' | 'cambios' | 'archivos' | 'memoria' | 'skills' | 'doctor' | 'stats' | 'contexto' | 'ajustes' | 'goals';

interface PanelSpec {
  readonly title: string;
  readonly endpoint?: string;
  readonly rpc?: { readonly method: string; readonly params?: Record<string, unknown> };
  readonly arrayKeys: readonly string[];
}

const SPECS: Record<Exclude<PanelId, 'actividad' | 'contexto' | 'ajustes' | 'archivos' | 'skills'>, PanelSpec> = {
  cambios: { title: 'Cambios Git', endpoint: '/changes.json', arrayKeys: ['entries', 'files', 'changes'] },
  memoria: { title: 'Memoria del operador', endpoint: '/memory.json', arrayKeys: ['facts', 'items'] },
  doctor: { title: 'Doctor', endpoint: '/doctor.json', arrayKeys: ['gate.chequeos', 'checks', 'items'] },
  stats: { title: 'Estadísticas', endpoint: '/stats.json', arrayKeys: ['daily', 'models', 'sessions', 'byProvider', 'items'] },
  goals: { title: 'Objetivos', endpoint: '/goals.json', arrayKeys: ['items', 'goals'] },
};

type Json = unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const at = (data: Json, path: string): unknown => {
  let node: unknown = data;
  for (const part of path.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
};

/** Primera ruta de `arrayKeys` que apunta a un array de objetos con contenido. */
const firstRows = (data: Json, keys: readonly string[]): { key: string; rows: readonly Record<string, Json>[] } | null => {
  for (const key of keys) {
    const value = at(data, key);
    if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) return { key, rows: value };
  }
  return null;
};

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

function Table({ rows }: { rows: readonly Record<string, Json>[] }) {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} data-label={column}>
                  {scalar(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RestPanel({ data, skip }: { data: Record<string, Json>; skip: string }) {
  const rows = Object.entries(data).filter(([key]) => key !== skip);
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map(([key, value]) =>
        Array.isArray(value) && value.length > 0 && value.every(isRecord) ? (
          <section key={key}>
            <h3>{key}</h3>
            <Table rows={value} />
          </section>
        ) : isRecord(value) ? (
          <section key={key}>
            <h3>{key}</h3>
            <div className="kv">
              {Object.entries(value).map(([k, v]) => (
                <div className="kv-row" key={k}>
                  <span>{k}</span>
                  <span>{scalar(v)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="kv-row" key={key}>
            <span>{key}</span>
            <span>{scalar(value)}</span>
          </div>
        ),
      )}
    </>
  );
}

function JsonPanel({ data, keys }: { data: Json; keys?: readonly string[] }) {
  const primary = keys && keys.length > 0 ? firstRows(data, keys) : null;
  if (primary) {
    return (
      <div className="kv">
        <section>
          <h3>{primary.key}</h3>
          <Table rows={primary.rows} />
        </section>
        {isRecord(data) ? <RestPanel data={data} skip={primary.key.split('.')[0] ?? ''} /> : null}
      </div>
    );
  }
  if (Array.isArray(data)) {
    const records = data.filter(isRecord);
    if (records.length === data.length && records.length > 0) return <Table rows={records} />;
    return (
      <ul className="plain-list">
        {data.map((item, index) => (
          <li key={index}>{scalar(item)}</li>
        ))}
      </ul>
    );
  }
  if (!isRecord(data)) return <pre className="json">{JSON.stringify(data, null, 2)}</pre>;
  const entries = Object.entries(data);
  return (
    <div className="kv">
      {entries.map(([key, value]) =>
        Array.isArray(value) && value.every(isRecord) && value.length > 0 ? (
          <section key={key}>
            <h3>{key}</h3>
            <Table rows={value as Record<string, Json>[]} />
          </section>
        ) : isRecord(value) ? (
          <section key={key}>
            <h3>{key}</h3>
            <div className="kv">
              {Object.entries(value).map(([k, v]) => (
                <div className="kv-row" key={k}>
                  <span>{k}</span>
                  <span>{scalar(v)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="kv-row" key={key}>
            <span>{key}</span>
            <span>{scalar(value)}</span>
          </div>
        ),
      )}
    </div>
  );
}

function ActivityPanel({ state }: { state: AppState }) {
  const rows = state.sessions
    .map((id) => state.sessionIndex[id])
    .filter((session): session is SessionState => Boolean(session))
    .map((session) => ({
      sesión: session.summary.title,
      estado: session.run ? 'en producción' : session.summary.running ? 'en producción' : 'quieta',
      mensajes: session.summary.messageCount ?? '—',
      actualizada: session.summary.updatedAt ?? '—',
    }));
  return <Table rows={rows} />;
}

function ContextPanel({ session }: { session: SessionState | null }) {
  if (!session?.usage) return <p className="muted">Todavía no llegó información de uso para este chat.</p>;
  const { used, limit, cost, inputTokens, outputTokens, autoCompactAt, modelUsage } = session.usage;
  const percent = used !== null && limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  return (
    <div className="kv">
      <div className="kv-row">
        <span>contexto</span>
        <span>
          {used ?? '—'} / {limit ?? '—'} {percent !== null ? `(${percent}%)` : ''}
        </span>
      </div>
      {autoCompactAt !== null ? (
        <div className="kv-row">
          <span>auto-compact</span>
          <span>{autoCompactAt}</span>
        </div>
      ) : null}
      <div className="kv-row">
        <span>tokens entrada/salida</span>
        <span>
          {inputTokens ?? '—'} / {outputTokens ?? '—'}
        </span>
      </div>
      <div className="kv-row">
        <span>costo acumulado</span>
        <span>{cost !== null ? `$${cost.toFixed(4)}` : '—'}</span>
      </div>
      {modelUsage.length > 0 ? <Table rows={modelUsage.map((model) => ({ modelo: model.model, entrada: model.inputTokens, salida: model.outputTokens, costo: model.cost }))} /> : null}
    </div>
  );
}

const SETTINGS_KEY = 'aegis.react.settings.v1';

interface Settings {
  readonly voice: string;
  readonly readAloud: boolean;
}

const readSettings = (): Settings => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return {
      voice: typeof parsed.voice === 'string' ? parsed.voice : 'es-AR-ElenaNeural',
      readAloud: parsed.readAloud === true,
    };
  } catch {
    return { voice: 'es-AR-ElenaNeural', readAloud: false };
  }
};

function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>(readSettings);
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);
  return (
    <div className="kv">
      <label className="kv-row">
        <span>voz de lectura</span>
        <select value={settings.voice} onChange={(event) => setSettings({ ...settings, voice: event.target.value })}>
          <option value="es-AR-ElenaNeural">Elena (es-AR)</option>
          <option value="es-AR-TomasNeural">Tomás (es-AR)</option>
          <option value="es-MX-DaliaNeural">Dalia (es-MX)</option>
          <option value="es-ES-ElviraNeural">Elvira (es-ES)</option>
          <option value="es-ES-AlvaroNeural">Álvaro (es-ES)</option>
        </select>
      </label>
      <label className="kv-row">
        <span>leer respuestas automáticamente</span>
        <input
          type="checkbox"
          checked={settings.readAloud}
          onChange={(event) => setSettings({ ...settings, readAloud: event.target.checked })}
        />
      </label>
    </div>
  );
}

export function WorkspacePanel({
  panel,
  onClose,
  state,
  session,
  store,
}: {
  panel: PanelId | null;
  onClose: () => void;
  state: AppState;
  session: SessionState | null;
  store: AegisStore;
}) {
  const [data, setData] = useState<Json>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const spec = panel && panel in SPECS ? SPECS[panel as keyof typeof SPECS] : null;

  useEffect(() => {
    if (!panel || !spec) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    const load = async (): Promise<void> => {
      try {
        let payload: Json;
        if (spec.rpc) payload = await store.request(spec.rpc.method, spec.rpc.params);
        else if (spec.endpoint) {
          const query = spec.endpoint === '/changes.json' && session?.summary.cwd ? `?cwd=${encodeURIComponent(session.summary.cwd)}` : '';
          const response = await fetch(`${spec.endpoint}${query}`, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          payload = (await response.json()) as Json;
        } else payload = null;
        if (!cancelled) setData(payload);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [panel, spec, session?.summary.cwd, store]);

  const title = panel === 'actividad' ? 'Actividad' : panel === 'contexto' ? 'Contexto' : panel === 'ajustes' ? 'Ajustes' : (spec?.title ?? 'Panel');

  return (
    <Dialog open={panel !== null} title={title} onClose={onClose} wide>
      {panel === 'archivos' ? <OutboxPanel /> : null}
      {panel === 'skills' ? <SkillsPanel store={store} /> : null}
      {panel === 'actividad' ? <ActivityPanel state={state} /> : null}
      {panel === 'contexto' ? <ContextPanel session={session} /> : null}
      {panel === 'ajustes' ? <SettingsPanel /> : null}
      {spec ? (
        loading ? (
          <p className="muted">Cargando…</p>
        ) : error ? (
          <p className="muted">No se pudo leer {spec.endpoint ?? spec.rpc?.method}: {error}</p>
        ) : data === null ? (
          <p className="muted">Sin datos.</p>
        ) : (
          <JsonPanel data={data} keys={spec.arrayKeys} />
        )
      ) : null}
    </Dialog>
  );
}

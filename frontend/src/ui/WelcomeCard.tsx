import { useEffect, useState } from 'react';
import type { AegisStore } from '../domain/store';
import type { SessionState } from '../domain/types';

/**
 * Estado vacío que enseña: con qué modelo habla esta máquina, cuánto cuesta, cuánto contexto hay, qué
 * skills tiene y qué objetivos están cargados.
 *
 * Mismo criterio que `web/src/onboarding.ts`: cada fila sale de un dato real (uso de la sesión,
 * `/prices.json`, `_aegis/unstable/sources/list`, `/goals.json`). Si un dato no llega, la fila no se
 * dibuja. `tools/list` no existe en este motor (medido: `-32601`), así que las skills ocup… [truncated]
 */

const fmtTok = (n: number): string => {  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
};

const getJson = async <T,>(url: string): Promise<T | null> => {
  try {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

interface Remote {  readonly precio: string | null;
  readonly skills: string | null;
  readonly objetivos: string | null;
  readonly nota: string | null;
}

const VACIO: Remote = { precio: null, skills: null, objetivos: null, nota: null };

export function WelcomeCard({ session, store }: { session: SessionState; store: AegisStore }) {
  const [remote, setRemote] = useState<Remote>(VACIO);

  // Los datos remotos se piden una vez por sesión: el uso cambia en cada notificación y no debe
  // reiniciar las peticiones (era la razón de que la tarjeta quedara vacía).
  useEffect(() => {
    let cancelled = false;
    setRemote(VACIO);
    void (async () => {
      const model = session.usage?.modelUsage?.[0]?.model ?? '';
      let precio: string | null = null;
      if (model) {
        const prices = await getJson<Record<string, { input?: number | null; output?: number | null }>>('/prices.json');
        for (const [key, row] of Object.entries(prices ?? {})) {
          if (key.startsWith('_') || !key.endsWith(`/${model}`)) continue;
          const input = typeof row.input === 'number' ? `$${row.input.toFixed(2)}` : '?';
          const output = typeof row.output === 'number' ? `$${row.output.toFixed(2)}` : '?';
          precio = `entrada ${input} / salida ${output} por 1M tok (estimada del store, no factura)`;
          break;
        }
      }

      let skills: string | null = null;
      let nota: string | null = null;
      try {
        const sources = await store.request<{ sources?: Array<{ name?: string }> }>('_aegis/unstable/sources/list', {});
        const nombres = (sources?.sources ?? []).map((source) => String(source.name ?? '')).filter(Boolean);
        if (nombres.length > 0) skills = `${nombres.length} cargadas · ej: ${nombres.slice(0, 3).join(', ')}`;
      } catch (error) {
        nota = `skills: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160);
      }

      const goals = await getJson<{ items?: Array<{ texto?: string; text?: string; title?: string }> }>('/goals.json');
      const recientes = (goals?.items ?? [])
        .slice(0, 3)
        .map((goal) => String(goal.texto ?? goal.text ?? goal.title ?? '').trim())
        .filter(Boolean);
      const objetivos = recientes.length > 0 ? recientes.join(' · ') : null;
      if (!objetivos && !nota) nota = 'objetivos: /goals.json no devolvió items';

      if (!cancelled) setRemote({ precio, skills, objetivos, nota });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- una vez por sesión, no por uso
  }, [session.summary.id, store]);

  const usage = session.usage;
  const model = usage?.modelUsage?.[0]?.model ?? '';
  const rows: Array<[string, string]> = [];
  if (model) rows.push(['modelo', model]);
  if (remote.precio) rows.push(['tarifa', remote.precio]);
  if (usage?.limit) rows.push(['contexto', `${fmtTok(usage.limit)} tok${usage.autoCompactAt ? ` · compacta a ${fmtTok(usage.autoCompactAt)} tok` : ''}`]);
  if (remote.skills) rows.push(['skills', remote.skills]);
  if (remote.objetivos) rows.push(['objetivos', remote.objetivos]);

  return (
    <div className="onboard">
      <h3>Con qué estás hablando</h3>
      {rows.length > 0 ? (
        <dl>
          {rows.map(([term, value]) => (
            <div key={term} className="onboard-row">
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">
          Todavía no hay turno en esta sesión: el modelo, la tarifa y el consumo aparecen acá después del primero.
        </p>
      )}
      {remote.nota ? <p className="onboard-nota">{remote.nota}</p> : null}
    </div>
  );
}

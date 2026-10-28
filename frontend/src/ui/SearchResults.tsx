import { useEffect, useRef, useState } from 'react';
import type { AegisStore } from '../domain/store';
import type { SessionId } from '../domain/ids';

interface SearchHitMatch {
  readonly role?: string;
  readonly ts?: number;
  readonly snippet?: string;
}

interface SearchHit {
  readonly sessionId?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly updatedAt?: string;
  readonly archived?: boolean;
  readonly titleMatch?: boolean;
  readonly matches?: readonly SearchHitMatch[];
}

/**
 * Búsqueda en el contenido de las sesiones (FTS5 del store) vía `/search.json`.
 * Debounce de 250 ms y guarda de secuencia: una respuesta vieja nunca pisa a una nueva.
 */
export function useContentSearch(
  query: string,
  limit = 12,
): { hits: SearchHit[]; loading: boolean; error: boolean } {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      seq.current += 1;
      setHits([]);
      setLoading(false);
      setError(false);
      return;
    }
    const mine = ++seq.current;
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void fetch(`/search.json?q=${encodeURIComponent(q).slice(0, 300)}&limit=${limit}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = (await response.json()) as { results?: SearchHit[]; _error?: string };
          if (data._error) throw new Error(data._error);
          if (mine !== seq.current) return;
          setHits(Array.isArray(data.results) ? data.results.slice(0, limit) : []);
          setError(false);
        })
        .catch(() => {
          if (mine !== seq.current || controller.signal.aborted) return;
          setHits([]);
          setError(true);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, limit]);

  return { hits, loading, error };
}

export interface SearchResultsProps {
  readonly query: string;
  readonly localIds: ReadonlySet<string>;
  readonly store: AegisStore;
  readonly onNavigate?: (() => void) | undefined;
}

/** Resultados que el filtro local no cubre: coincidencias dentro del texto de mensajes guardados. */
export function SearchResults({ query, localIds, store, onNavigate }: SearchResultsProps) {
  const { hits, loading, error } = useContentSearch(query);
  const q = query.trim();
  if (q.length < 2 || error) return null;
  if (loading) return <div className="sb-empty">Buscando en el contenido…</div>;
  const remote = hits.filter((hit) => {
    const id = hit.sessionId ?? '';
    return id !== '' && !localIds.has(id);
  });
  if (remote.length === 0) return null;
  return (
    <>
      <div className="sb-group" role="presentation">
        En el contenido ({hits.length})
      </div>
      {remote.map((hit) => {
        const id = (hit.sessionId ?? '') as SessionId;
        const first = hit.matches?.[0];
        const snippet = first?.snippet ?? '';
        const extra = Math.max(0, (hit.matches?.length ?? 0) - 1);
        return (
          <div className="sb-row" key={`hit:${id}`}>
            <button
              type="button"
              className="sb-item"
              onClick={() => {
                void store.openSession(id);
                onNavigate?.();
              }}
            >
              <span className="sb-title">
                <span className="sb-name">{hit.title || id}</span>
              </span>
              {snippet ? (
                <span className="sb-sub">
                  {snippet}
                  {extra > 0 ? ` (+${extra})` : ''}
                </span>
              ) : (
                <span className="sb-sub">coincide en el título</span>
              )}
            </button>
          </div>
        );
      })}
    </>
  );
}

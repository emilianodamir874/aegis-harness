import { useEffect, useState } from 'react';
import { renderMarkdown } from '../render/markdown';

interface OutboxItem {
  readonly name: string;
  readonly bytes: number;
  readonly mtime: string;
  readonly ext: string;
  readonly url: string;
}

interface Preview {
  readonly name: string;
  readonly bytes: number;
  readonly ext: string;
  readonly binary: boolean;
  readonly text?: string;
  readonly dataUrl?: string;
}

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const esMarkdown = (ext: string): boolean => ext === '.md' || ext === '.markdown' || ext === '.txt';
const esImagen = (ext: string): boolean => ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);

/**
 * Galería del outbox: lista los archivos que deja el agente y muestra su contenido sin salir del
 * cliente. Contrato real medido (2026-10-28): `/outbox.json` → `{dir, items[{name,bytes,mtime,ext,url}]}`
 * y `/outbox.json?name=X&preview=1` → `{name,bytes,ext,binary,text,dataUrl}`.
 */
export function OutboxPanel() {
  const [items, setItems] = useState<OutboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/outbox.json', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { items?: OutboxItem[] };
        setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setPreview(null);
    setPreviewError(null);
    void fetch(`/outbox.json?name=${encodeURIComponent(selected)}&preview=1`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setPreview((await response.json()) as Preview);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setPreviewError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => controller.abort();
  }, [selected]);

  if (error) return <p className="muted">No se pudo leer /outbox.json: {error}</p>;
  if (items === null) return <p className="muted">Cargando archivos…</p>;
  if (items.length === 0) return <p className="muted">El outbox está vacío.</p>;

  return (
    <div className="outbox">
      <ul className="outbox-list">
        {items.map((item) => (
          <li key={item.name}>
            <button
              type="button"
              className={item.name === selected ? 'active' : undefined}
              aria-pressed={item.name === selected}
              onClick={() => setSelected(item.name)}
            >
              <span className="outbox-name">{item.name}</span>
              <span className="outbox-meta">
                {kb(item.bytes)} · {item.mtime.slice(0, 16).replace('T', ' ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="outbox-preview">
        {selected === null ? <p className="muted">Elegí un archivo para verlo.</p> : null}
        {previewError ? <p className="muted">No se pudo previsualizar: {previewError}</p> : null}
        {selected !== null && previewError === null && preview === null ? <p className="muted">Cargando…</p> : null}
        {preview ? (
          <>
            <div className="outbox-actions">
              <a href={`/dl/${encodeURIComponent(preview.name)}`} download>
                Descargar
              </a>
              <span className="muted">
                {kb(preview.bytes)} · {preview.ext || 'sin extensión'}
                {preview.binary && !esImagen(preview.ext) ? ' · binario' : ''}
              </span>
            </div>
            {esImagen(preview.ext) && preview.dataUrl ? (
              <img src={preview.dataUrl} alt={preview.name} className="outbox-image" />
            ) : preview.text !== undefined && esMarkdown(preview.ext) ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.text) }} />
            ) : preview.text !== undefined ? (
              <pre className="json">{preview.text.slice(0, 20000)}</pre>
            ) : (
              <p className="muted">Sin vista previa para este tipo de archivo.</p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

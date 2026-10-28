import { useEffect, useMemo, useRef } from 'react';
import type { BlockEntity, MessageEntity, SessionState, ToolEntity } from '../domain/types';
import { renderMarkdown } from '../render/markdown';
import { diffNote, diffSummary, formatToolDiff } from '../render/diff';

interface TranscriptProps {
  readonly session: SessionState;
  readonly onRewind: (messageId: string) => void;
  readonly onRetry: () => void;
  readonly onLoadFull: () => void;
}

type Item =
  | { readonly kind: 'message'; readonly seq: number; readonly message: MessageEntity }
  | { readonly kind: 'tool'; readonly seq: number; readonly tool: ToolEntity };

const toolStatusLabel: Record<ToolEntity['status'], string> = {
  pending: 'en cola',
  in_progress: 'ejecutando',
  completed: 'listo',
  failed: 'falló',
};

function ToolCard({ tool }: { tool: ToolEntity }) {
  const state = tool.interrupted && tool.status !== 'completed' && tool.status !== 'failed' ? 'interrumpida' : toolStatusLabel[tool.status];
  const cls = tool.status === 'completed' ? 'ok' : tool.status === 'failed' ? 'err' : 'run';
  return (
    <details className={`tool tool-${cls}`} data-tool-id={tool.id}>
      <summary className="tool-head">
        <span className="tool-ic" aria-hidden="true" />
        <span className="tool-title">
          {tool.title}
          {tool.name && tool.name !== tool.title ? <span className="tname">{tool.name}</span> : null}
        </span>
        <span className={`tool-state ${tool.interrupted ? 'warn' : ''}`}>{state}</span>
      </summary>
      {tool.rawInput ? (
        <pre className="tool-input">
          {Object.entries(tool.rawInput)
            .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
            .join('\n')}
        </pre>
      ) : null}
      {tool.diffs.map((diff, index) => {
        const view = formatToolDiff(diff.oldText, diff.newText);
        return (
          <details className={`tool-diff${diff.requested ? ' tool-diff-request' : ''}`} key={`${diff.path}-${index}`} open={index === 0}>
            <summary>
              <span className="tool-diff-path">{diff.path}</span>
              <span className="tool-diff-count">{diffSummary(view, diff.requested)}</span>
            </summary>
            <p className="tool-diff-note">{diffNote(diff.requested, diff.oldText !== undefined)}</p>
            {view.lines.length ? (
              <pre className="tool-diff-code">
                {view.lines.map((change, i) => (
                  <span key={i} className={change.kind === '+' ? 'add' : change.kind === '-' ? 'del' : 'context'}>
                    {change.kind}
                    {change.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            ) : null}
            {view.clipped ? <p className="tool-diff-note">Vista recortada; el contenido completo no se muestra aquí.</p> : null}
          </details>
        );
      })}
      {tool.output ? (
        <pre className="tool-body">{tool.output}</pre>
      ) : tool.status === 'in_progress' || tool.status === 'pending' ? (
        <p className="tool-note">Sin salida todavía.</p>
      ) : null}
    </details>
  );
}

function Blocks({ blocks, message }: { blocks: readonly BlockEntity[]; message: MessageEntity }) {
  return (
    <>
      {blocks.map((block) => {
        if (block.imageUrl) {
          return (
            <figure className="att" key={block.id}>
              <img src={block.imageUrl} alt={block.attachmentName ?? 'imagen adjunta'} loading="lazy" />
              {block.attachmentName ? <figcaption>{block.attachmentName}</figcaption> : null}
            </figure>
          );
        }
        if (message.kind === 'user') {
          return (
            <p className="att-text" key={block.id}>
              {block.text}
            </p>
          );
        }
        return (
          <div
            className={`md${block.status === 'streaming' ? ' streaming' : ''}`}
            key={block.id}
            // renderMarkdown escapa todo el texto antes de insertar markup.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
          />
        );
      })}
    </>
  );
}

export function Transcript({ session, onRewind, onRetry, onLoadFull }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const id of session.messages) {
      const message = session.messageIndex[id];
      if (message) list.push({ kind: 'message', seq: message.seq, message });
    }
    for (const id of session.tools) {
      const tool = session.toolIndex[id];
      if (tool) list.push({ kind: 'tool', seq: tool.seq, tool });
    }
    return list.sort((a, b) => a.seq - b.seq);
  }, [session.messages, session.messageIndex, session.tools, session.toolIndex]);

  // Autoscroll sólo si el operador ya estaba abajo: leer hacia arriba nunca debe ser arrancado.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
  }, [items]);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const onScroll = (): void => {
      stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  // Copiar bloques de código por delegación: un listener para todo el transcript.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const onClick = (event: MouseEvent): void => {
      const button = (event.target as HTMLElement | null)?.closest('.copy-code');
      if (!button) return;
      const code = button.parentElement?.querySelector('code')?.textContent ?? '';
      void navigator.clipboard.writeText(code).then(() => {
        button.textContent = 'Copiado';
        setTimeout(() => {
          button.textContent = 'Copiar';
        }, 1200);
      });
    };
    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }, []);

  if (items.length === 0) {
    return (
      <div className="transcript empty" ref={scroller}>
        <div className="welcome">
          <h1>{session.summary.title}</h1>
          <p>
            Escribí abajo para empezar. Las respuestas se streamean y las herramientas aparecen como tarjetas con su
            salida y sus diffs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript" ref={scroller} role="log" aria-live="polite" aria-relevant="additions text">
      {session.replaySkipped > 0 && !session.fullHistory ? (
        <div className="tail-pill" role="status">
          <span>{session.replaySkipped.toLocaleString('es-AR')} mensajes anteriores no se cargaron para abrir rápido.</span>
          <button type="button" className="xbtn" onClick={onLoadFull}>
            Cargar todo
          </button>
        </div>
      ) : null}

      {items.map((item) =>
        item.kind === 'tool' ? (
          <ToolCard key={`t:${item.tool.id}`} tool={item.tool} />
        ) : (
          <article
            key={`m:${item.message.id}`}
            className={`msg msg-${item.message.kind}${item.message.hidden ? ' hidden' : ''}${item.message.pending ? ' pending' : ''}`}
            data-mid={item.message.id}
            style={{ contentVisibility: 'auto', containIntrinsicSize: '80px' }}
          >
            {item.message.kind === 'thought' ? (
              <details className="thought">
                <summary>Razonamiento</summary>
                <Blocks blocks={item.message.blocks.map((id) => session.blocks[id]).filter((b): b is BlockEntity => Boolean(b))} message={item.message} />
              </details>
            ) : (
              <Blocks blocks={item.message.blocks.map((id) => session.blocks[id]).filter((b): b is BlockEntity => Boolean(b))} message={item.message} />
            )}
            {item.message.pending ? <span className="pending-tag">sin confirmar</span> : null}
            <div className="msg-actions">
              {item.message.kind === 'user' && !item.message.pending ? (
                <button type="button" className="xbtn" onClick={() => onRewind(item.message.id)} title="Rebobinar hasta este mensaje">
                  Rebobinar
                </button>
              ) : null}
              {item.message.kind === 'assistant' ? (
                <button type="button" className="xbtn" onClick={onRetry} title="Regenerar la última respuesta">
                  Regenerar
                </button>
              ) : null}
            </div>
          </article>
        ),
      )}
    </div>
  );
}

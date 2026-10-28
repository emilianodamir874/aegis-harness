import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { AegisStore } from '../domain/store';
import type { Attachment, SessionState } from '../domain/types';
import { isRunning } from '../domain/selectors';
import { attachmentId } from '../domain/ids';
import { blobToWavBase64, createSpeechPlayer, startDictation, type SpeechPlayer } from '../media/audio';
import { PERMISSION_MODE_HINT, type PermissionMode } from '../domain/sessionMode';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

const isImage = (file: File): boolean => file.type.startsWith('image/');

async function readAttachment(file: File): Promise<Attachment> {
  const id = attachmentId(`att:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
  if (isImage(file)) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} supera 8 MB`);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(`no se pudo leer ${file.name}`));
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { id, name: file.name, mimeType: file.type, size: file.size, data: base64 };
  }
  if (file.size > MAX_TEXT_BYTES) throw new Error(`${file.name} supera 256 KB de texto`);
  const text = await file.text();
  return { id, name: file.name, mimeType: file.type || 'text/plain', size: file.size, text };
}

export function Composer({
  store,
  session,
  prefill,
  onPrefillApplied,
  mode,
  onCycleMode,
  onNotice,
}: {
  store: AegisStore;
  session: SessionState;
  prefill?: string | null;
  onPrefillApplied?: () => void;
  mode?: PermissionMode;
  onCycleMode?: () => void;
  onNotice: (level: 'info' | 'warn' | 'error', text: string) => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!prefill) return;
    setText((current) => (current.trim() ? `${current.trim()}\n\n${prefill}` : prefill));
    onPrefillApplied?.();
  }, [prefill, onPrefillApplied]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const dictation = useRef<Awaited<ReturnType<typeof startDictation>> | null>(null);
  const player = useRef<SpeechPlayer | null>(null);
  const running = isRunning(session);

  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [text]);

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        const attachment = await readAttachment(file);
        setAttachments((current) => [...current, attachment]);
      } catch (error) {
        onNotice('error', error instanceof Error ? error.message : String(error));
      }
    }
  };

  const send = async (): Promise<void> => {    if (sending) return;
    const payload = text;
    if (!payload.trim() && attachments.length === 0) return;
    setSending(true);
    try {
      await store.submit(payload, attachments);
      setText('');
      setAttachments([]);
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  // Pegar desde el portapapeles: una captura de pantalla llega como archivo, no como texto.
  // Sin esto, Ctrl+V de una imagen no adjunta nada (el textarea la descarta en silencio).
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const archivos = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (archivos.length === 0) return;
    event.preventDefault();
    const lista = new DataTransfer();
    for (const archivo of archivos) lista.items.add(archivo);
    void addFiles(lista.files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const toggleDictation = async (): Promise<void> => {
    if (!dictating) {
      try {
        dictation.current = await startDictation();
        setDictating(true);
      } catch (error) {
        onNotice('error', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const handle = dictation.current;
    dictation.current = null;
    setDictating(false);
    if (!handle) return;
    try {
      const blob = await handle.stop();
      const wav = await blobToWavBase64(blob);
      const transcript = await store.transcribe(wav);
      if (transcript) setText((current) => (current ? `${current} ${transcript}` : transcript));
    } catch (error) {
      onNotice('error', `Dictado: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const toggleSpeech = async (): Promise<void> => {
    if (!player.current) player.current = createSpeechPlayer();
    if (speaking) {
      player.current.stop();
      setSpeaking(false);
      return;
    }
    const spoken = session.messages
      .map((id) => session.messageIndex[id])
      .filter((message): message is NonNullable<typeof message> => Boolean(message) && message!.kind === 'assistant')
      .at(-1);
    if (!spoken) {
      onNotice('info', 'No hay respuesta para leer todavía.');
      return;
    }
    const body = spoken.blocks
      .map((id) => session.blocks[id]?.text ?? '')
      .join('\n')
      .trim();
    setSpeaking(true);
    try {
      await player.current.speak(body);
    } finally {
      setSpeaking(false);
    }
  };

  return (
    <div
      className={`composer-wrap${arrastrando ? ' dragging' : ''}`}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setArrastrando(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setArrastrando(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setArrastrando(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      {session.permissions.length > 0 ? (
        <p className="composer-hint warn">Hay {session.permissions.length} confirmación(es) pendiente(s) arriba.</p>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="att-list" aria-label="Adjuntos">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span>{attachment.name}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Quitar ${attachment.name}`}
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="composer">
        <label className="sr-only" htmlFor="input">
          Mensaje
        </label>
        <textarea
          id="input"
          ref={area}
          value={text}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={running ? 'Indicación para el turno en curso…' : 'Escribí un mensaje…'}
          rows={1}
          spellCheck
        />
        <div className="composer-tools">
          {mode && onCycleMode ? (
            <button
              type="button"
              className={`mode-chip mode-${mode}`}
              data-mode={mode}
              title={`${PERMISSION_MODE_HINT[mode]} Click para cambiar (plan → ejecutar → revisar).`}
              aria-label={`Modo ${mode}: ${PERMISSION_MODE_HINT[mode]}`}
              onClick={onCycleMode}
            >
              {mode}
            </button>
          ) : null}
          <button type="button" className="icon-btn" title="Adjuntar archivo" aria-label="Adjuntar archivo" onClick={() => fileInput.current?.click()}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M12.5 7.5 8 12a2.5 2.5 0 0 0 3.5 3.5l4.5-4.5a4.5 4.5 0 0 0-6.4-6.4L5 9.1a6 6 0 0 0 8.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className={`icon-btn${dictating ? ' active' : ''}`}
            title={dictating ? 'Detener dictado' : 'Dictar'}
            aria-label={dictating ? 'Detener dictado' : 'Dictar'}
            aria-pressed={dictating}
            onClick={() => void toggleDictation()}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="7.5" y="2.5" width="5" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={`icon-btn${speaking ? ' active' : ''}`}
            title={speaking ? 'Detener lectura' : 'Leer la última respuesta'}
            aria-label={speaking ? 'Detener lectura' : 'Leer la última respuesta'}
            aria-pressed={speaking}
            onClick={() => void toggleSpeech()}
          >
            {speaking ? '■' : '🔊'}
          </button>
          <span className="composer-spacer" />
          {running ? (
            <>
              <button type="button" className="xbtn" onClick={() => void store.cancel()}>
                Detener
              </button>
              <button type="button" className="send" disabled={sending || (!text.trim() && attachments.length === 0)} onClick={() => void send()}>
                Indicar
              </button>
            </>
          ) : (
            <button type="button" className="send" disabled={sending || (!text.trim() && attachments.length === 0)} onClick={() => void send()}>
              {sending ? 'Enviando…' : 'Enviar'}
            </button>
          )}
        </div>
      </div>

      {session.usage && session.usage.limit ? (
        <div className="usage" role="status" aria-label="Uso de contexto">
          <span>
            {Math.round(((session.usage.used ?? 0) / session.usage.limit) * 100)}% de {Math.round(session.usage.limit / 1000)}k
          </span>
          {session.speed ? <span>{session.speed.toFixed(0)} tok/s</span> : null}
          {session.usage.cost !== null ? <span>${session.usage.cost.toFixed(3)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

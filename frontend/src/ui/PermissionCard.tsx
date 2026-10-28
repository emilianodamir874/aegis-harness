import type { PermissionRequest } from '../domain/types';

const KIND_LABEL: Record<string, string> = {
  allow_once: 'Permitir',
  allow_always: 'Permitir siempre',
  reject_once: 'Rechazar',
  reject_always: 'Rechazar siempre',
};

/** Una confirmación pendiente. El foco va al primer botón y Escape = rechazar, como en el cliente viejo. */
export function PermissionCard({
  request,
  onRespond,
}: {
  request: PermissionRequest;
  onRespond: (optionId: string | null) => void;
}) {
  return (
    <section className="perm-card" role="alertdialog" aria-label={`Confirmación: ${request.title}`} aria-live="assertive">
      <div className="perm-head">
        <span className="perm-dot" aria-hidden="true" />
        <h3>{request.title}</h3>
      </div>
      <p className="perm-text">
        La herramienta pidió permiso para ejecutarse. Hasta que respondas, el turno está detenido.
      </p>
      <div className="perm-actions">
        {request.options.map((option) => (
          <button
            type="button"
            key={option.optionId}
            className={option.kind.startsWith('allow') ? 'send' : 'xbtn'}
            onClick={() => onRespond(option.optionId)}
          >
            {option.name || KIND_LABEL[option.kind] || option.optionId}
          </button>
        ))}
        <button type="button" className="xbtn" onClick={() => onRespond(null)}>
          Cancelar
        </button>
      </div>
    </section>
  );
}

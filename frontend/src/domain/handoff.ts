/* Handoff entre sesiones — la mitad útil sin split view.
 *
 * Porta la heurística del cliente actual (`web/src/handoff.ts`): desde el transcript de la sesión
 * origen arma un bloque objetivo/estado/decisiones/próximos pasos, filtra líneas con forma de
 * credencial y no inventa pasos: sólo reescribe lo que ya está escrito. El bloque se edita antes de
 * insertarse, igual que antes.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
];

export const hasSecret = (line: string): boolean => SECRET_PATTERNS.some((pattern) => pattern.test(line));

const clip = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export function buildHandoff(title: string, transcript: string): string {
  const lines = transcript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const sinSecretos = lines.filter((line) => !hasSecret(line));

  const objetivo =
    sinSecretos.find((line) => line.startsWith('>') && line.length > 20) ??
    sinSecretos.find((line) => !/^#{1,2}\s/.test(line) && line.length > 40) ??
    '';

  const decisiones = sinSecretos
    .filter((line) => /\b(decid|eleg|conviene|arregl|qued[oó]|commit|merge)/i.test(line))
    .slice(-8)
    .map((line) => `- ${clip(line, 240)}`);

  const pendientes = sinSecretos
    .filter((line) => /\b(falta|pendiente|todo|pr[oó]xim|queda por|sin resolver|romp)/i.test(line))
    .slice(-8)
    .map((line) => `- ${clip(line, 240)}`);

  const estado = sinSecretos
    .slice(-6)
    .map((line) => clip(line, 200))
    .join(' ');

  const parts: string[] = [`## Handoff · ${title || 'sesión anterior'}`, ''];
  parts.push('### Objetivo', objetivo ? clip(objetivo.replace(/^>\s*/, ''), 600) : '(no detectado: completalo a mano)');
  parts.push('', '### Estado', estado || '(no detectado)');
  if (decisiones.length > 0) parts.push('', '### Decisiones', ...decisiones);
  if (pendientes.length > 0) parts.push('', '### Próximos pasos', ...pendientes);
  parts.push('', '_Generado desde el transcript de la sesión origen. Revisar antes de enviar._');
  return parts.join('\n');
}

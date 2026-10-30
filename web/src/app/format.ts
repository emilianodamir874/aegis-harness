// Helpers puros del cliente: formateo de numeros, costo y ritmo de tokens.
// No tocan el DOM ni el estado de la app: entran valores, salen strings/numeros.

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export const fmtTok = (n: number | null | undefined): string => {
  if (n == null) return '–';
  if (n < 1000) return String(n);
  if (n < 1000000) return (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'k';
  return (Math.round(n / 104857.6) / 10).toString().replace(/\.0$/, '') + 'M';
};

export const fmtCost = (c: number | null | undefined): string => {
  if (c == null) return '';
  if (c === 0) return '$0';
  const s = c < 0.01 ? c.toFixed(5) : c.toFixed(4);
  return '$' + s.replace(/0+$/, '').replace(/\.$/, '');
};

export const fmtSize = (n: number | null | undefined): string => {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 102.4) / 10 + ' KB';
  return Math.round(n / 104857.6) / 10 + ' MB';
};

export const fmtTps = (v: number): string => (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' tok/s';

export function s0(value: unknown): number {
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

// generationMs mide el primer al último contenido observado (sin depender de TTFT).
// Un registro histórico sin esa medición sólo permite throughput de solicitud total.
// Nunca inferir generación restando TTFT: retries y pasos tool-only lo invalidan.
export type StepRate = { value: number; kind: 'generation' | 'request'; durationMs: number };
export function stepRate(u: { outputTokens?: number; elapsedMs?: number; generationMs?: number | null; timeToFirstTokenMs?: number | null } | null | undefined): StepRate | null {
  const output = u?.outputTokens;
  if (typeof output !== 'number' || !Number.isFinite(output) || output <= 0) return null;
  const generation = u?.generationMs;
  const hasGeneration = typeof generation === 'number' && Number.isFinite(generation) && generation > 0;
  const durationMs = hasGeneration ? generation : u?.elapsedMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return { value: output / (durationMs / 1000), kind: hasGeneration ? 'generation' : 'request', durationMs };
}
export function tpsOf(u: Parameters<typeof stepRate>[0]): number | null {
  const rate = stepRate(u);
  return rate?.kind === 'generation' ? rate.value : null;
}

export const COMPACT_RATIO = 0.8; // AEGIS_AUTO_COMPACT_THRESHOLD por defecto: compacta a 80% del limite

export type CompactTrigger = { at: number | null; pct: number | null; estimated: boolean };

// Disparador real de compactacion: lo manda el server (autoCompactAt/autoCompactPct,
// ya resuelto contra AEGIS_AUTO_COMPACT_TOKEN_LIMIT). Si todavia no llego, cae al 80%
// del limite y la UI lo marca como estimado.
export function compactTrig(st: { autoCompactAt?: number | null; autoCompactPct?: number | null; limit?: number | null } | null | undefined): CompactTrigger {
  if (!st) return { at: null, pct: null, estimated: true };
  if (st.autoCompactAt != null) {
    return {
      at: st.autoCompactAt,
      pct: st.autoCompactPct != null ? st.autoCompactPct * 100 : (st.limit ? (st.autoCompactAt / st.limit) * 100 : null),
      estimated: false,
    };
  }
  if (st.limit) return { at: st.limit * COMPACT_RATIO, pct: COMPACT_RATIO * 100, estimated: true };
  return { at: null, pct: null, estimated: true };
}

export const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

export const dayLabel = (iso: string | null | undefined): string => {
  const d = new Date(iso as string);
  if (isNaN(d.getTime())) return 'Más antiguas';
  const now = new Date();
  if (sameDay(d, now)) return 'Hoy';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Ayer';
  if (now.getTime() - d.getTime() < 7 * 864e5) return 'Esta semana';
  if (now.getTime() - d.getTime() < 31 * 864e5) return 'Este mes';
  return 'Más antiguas';
};

export const fmtTime = (iso: string | null | undefined): string => {
  const d = new Date(iso as string);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (sameDay(d, now)) return d.toTimeString().slice(0, 5);
  return d.getDate() + '/' + (d.getMonth() + 1);
};

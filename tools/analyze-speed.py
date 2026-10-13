# Análisis de velocidad + detalle (segunda parte).
# - gaps entre llamadas al modelo (ledger) = tiempo por paso
# - duraciones de herramientas (toolRequest -> toolResponse por id)
# - mayores salidas de herramientas, histograma de herramientas
# - thinking vs texto, crecimiento de contexto
# - mensajes huérfanos (sesiones borradas dejaron restos?)
import sqlite3, datetime, json, collections, statistics
TZ = datetime.timezone(datetime.timedelta(hours=-3))
db = 'C:/Users/Emiliano/AppData/Roaming/Block/goose/data/sessions/sessions.db'
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=10)
c = con.cursor()

def pct(xs, p):
    if not xs: return 0
    xs = sorted(xs)
    i = min(len(xs) - 1, int(round((p / 100) * (len(xs) - 1))))
    return xs[i]

print("== 1) LATENCIA POR PASO (gap entre llamadas al modelo, hoy) ==")
for sid in ('20261012_23', '20261012_19', '20261012_20', '20261012_24'):
    ts = [r[0] for r in c.execute("select created_timestamp from usage_ledger where session_id=? order by created_timestamp", (sid,))]
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    if not gaps: continue
    gaps_m = [g / 60 for g in gaps if g > 0]
    print(f"{sid}: llamadas={len(ts)} | gap p50={pct(gaps,50):.0f}s p90={pct(gaps,90):.0f}s max={max(gaps):.0f}s | suma={sum(gaps)/60:.0f}min")

print()
print("== 2) CRECIMIENTO DEL CONTEXTO (=input tokens por llamada) ==")
for sid in ('20261012_23', '20261012_19'):
    rows = list(c.execute("select created_timestamp, input_tokens, output_tokens, model from usage_ledger where session_id=? order by created_timestamp", (sid,)))
    if not rows: continue
    print(f"{sid}: primera llamada in={rows[0][1]} | max in={max(r[1] for r in rows)} | ultima in={rows[-1][1]}")
    step = max(1, len(rows) // 8)
    print("   curva:", ' → '.join(f"{r[1]//1000}k" for r in rows[::step]))

print()
print("== 3) HERRAMIENTAS hoy: cuantas veces cada una (top 12) ==")
tool_count = collections.Counter()
tool_bytes = collections.Counter()
big = []
t_by_id = {}
for r in c.execute("""select session_id, id, role, created_timestamp, length(content_json), content_json
 from messages where created_timestamp > ? and content_json like '%toolRequest%'""", (datetime.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp(),)):
    sid, mid, role, ts, nbytes, cj = r
    try:
        blocks = json.loads(cj)
    except Exception:
        continue
    for b in blocks:
        if b.get('type') != 'toolRequest': continue
        v = (b.get('toolCall') or {}).get('value') or {}
        name = v.get('name') or '?'
        tid = b.get('id')
        tool_count[name] += 1
        t_by_id[tid] = (name, ts, len(cj))
# respuestas
for r in c.execute("""select content_json, created_timestamp from messages
 where created_timestamp > ? and content_json like '%toolResponse%'""", (datetime.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp(),)):
    cj, ts = r
    try:
        blocks = json.loads(cj)
    except Exception:
        continue
    for b in blocks:
        if b.get('type') != 'toolResponse': continue
        tid = b.get('id')
        big.append((len(cj), tid, ts))
        if tid in t_by_id:
            name, t0, _ = t_by_id[tid]
            tool_bytes[name] += len(cj)
for name, n in tool_count.most_common(12):
    print(f"  {name:14} llamadas={n:>4} | bytes respuesta={tool_bytes.get(name,0):>9}")
print()
print("== 4) TOP 12 salidas de herramienta mas grandes (hoy) + duracion req->resp ==")
big.sort(reverse=True)
for nb, tid, ts in big[:12]:
    nm, t0, _ = t_by_id.get(tid, ('?', None, 0))
    dur = (ts - t0) if t0 else None
    ds = f"{dur:6.1f}s" if dur is not None else "   ?  "
    print(f"  {nb:>8} bytes  {nm:12} {ds}  id={str(tid)[:20]}")

print()
print("== 5) thinking vs texto (top sesiones hoy, bytes) ==")
for sid in ('20261012_23', '20261012_19', '20261012_20', '20261012_2'):
    th = tx = tr = 0
    for r in c.execute("select content_json, role from messages where session_id=?", (sid,)):
        try:
            for b in json.loads(r[0]):
                t = b.get('type')
                if t == 'thinking': th += len(b.get('thinking') or '')
                elif t == 'text': tx += len(b.get('text') or '')
                elif t == 'toolResponse': tr += len(r[0])
        except Exception:
            pass
    print(f"  {sid}: thinking={th/1024:.0f}KB | texto={tx/1024:.0f}KB | toolResp={tr/1024:.0f}KB")

print()
print("== 6) huerfanos: mensajes de sesiones que ya no existen ==")
orph = c.execute("select count(*), sum(length(content_json)) from messages where session_id not in (select id from sessions)").fetchone()
print("  mensajes huerfanos:", orph[0], "| bytes:", orph[1])
del_sessions = c.execute("select count(*) from sessions where archived_at is not null").fetchone()[0]
print("  sesiones archivadas:", del_sessions)
print()
print("== 7) uso del ledger por tramo horario (hoy) ==")
byhour = collections.Counter()
for (ts, n) in c.execute("select created_timestamp, count(*) from usage_ledger where created_timestamp > ? group by created_timestamp", (datetime.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp(),)):
    h = datetime.datetime.fromtimestamp(ts, TZ).strftime('%H')
    byhour[h] += n
print("  ", dict(sorted(byhour.items())))

# Tercera parte: redundancia, herramientas lentas, detalle de compactación.
import sqlite3, datetime, json, collections
TZ = datetime.timezone(datetime.timedelta(hours=-3))
db = 'C:/Users/Emiliano/AppData/Roaming/Block/goose/data/sessions/sessions.db'
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=10)
c = con.cursor()
midnight = datetime.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

t_by_id = {}
durations = []
cmds = []
for r in c.execute("""select id, content_json, created_timestamp from messages where created_timestamp > ?
 and content_json like '%toolRequest%'""", (midnight,)):
    try:
        blocks = json.loads(r[1])
    except Exception:
        continue
    for b in blocks:
        if b.get('type') != 'toolRequest': continue
        v = (b.get('toolCall') or {}).get('value') or {}
        t_by_id[b.get('id')] = (v.get('name') or '?', r[2])
        if v.get('name') == 'shell':
            args = v.get('arguments') or {}
            cmd = (args.get('command') or '')[:110]
            if cmd: cmds.append(cmd)
for r in c.execute("""select content_json, created_timestamp from messages where created_timestamp > ?
 and content_json like '%toolResponse%'""", (midnight,)):
    try:
        blocks = json.loads(r[0])
    except Exception:
        continue
    for b in blocks:
        if b.get('type') != 'toolResponse': continue
        tid = b.get('id')
        if tid in t_by_id:
            name, t0 = t_by_id[tid]
            durations.append((r[1] - t0, name, tid))

print("== herramientas por duracion: top 15 mas lentas (hoy) ==")
for dur, name, tid in sorted(durations, reverse=True)[:15]:
    print(f"  {dur:7.1f}s  {name}")
slow20 = [d for d, n, _ in durations if d > 20]
slow60 = [d for d, n, _ in durations if d > 60]
print(f"  >20s: {len(slow20)} llamadas | >60s: {len(slow60)}")

print()
print("== comandos shell repetidos (posible redundancia, hoy) ==")
norm = collections.Counter()
for cmd in cmds:
    key = cmd.split('&')[0].strip().lower()[:90]
    norm[key] += 1
for k, v in norm.most_common(12):
    if v > 1:
        print(f"  x{v:>2}  {k}")

print()
print("== compactacion de _23 (detalle) ==")
for r in c.execute("select id, created_timestamp, model, input_tokens, output_tokens, cost from usage_ledger where is_compaction=1"):
    print(f"  {r[0]} {datetime.datetime.fromtimestamp(r[1], TZ).strftime('%H:%M:%S')} model={r[2]} in={r[3]} out={r[4]}")

print()
print("== primeras 4 llamadas de la sesion pequeña (¿auto-titulo?) ==")
for r in c.execute("select created_timestamp, model, input_tokens, output_tokens, total_tokens, cost from usage_ledger where session_id='20261012_24' order by created_timestamp"):
    print(f"  {datetime.datetime.fromtimestamp(r[0], TZ).strftime('%H:%M:%S')} {r[1]} in={r[2]} out={r[3]} tot={r[4]} ${r[5]:.5f}")

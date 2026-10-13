# Análisis a fondo de sesiones + tokens + velocidad (goose fork, serve v1).
# Salida: tablas compactas a stdout + JSON completo a session-analysis.json
import sqlite3, datetime, json, collections
TZ = datetime.timezone(datetime.timedelta(hours=-3))
db = 'C:/Users/Emiliano/AppData/Roaming/Block/goose/data/sessions/sessions.db'
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=10)
c = con.cursor()

def loc(ts):
    if ts is None: return '—'
    try:
        if isinstance(ts, str):
            # ISO UTC "2026-10-12 16:51:51"
            dt = datetime.datetime.strptime(ts[:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone.utc)
            return dt.astimezone(TZ).strftime('%d/%m %H:%M')
        ts = float(ts)
        if ts > 1e12: ts /= 1000
        return datetime.datetime.fromtimestamp(ts, TZ).strftime('%d/%m %H:%M')
    except Exception:
        return str(ts)[:16]

def hm(ts):
    return loc(ts)[-5:] if ts else '—'

out = {'generado': datetime.datetime.now(TZ).strftime('%Y-%m-%d %H:%M:%S')}

# ---- 1) sesiones ----
sess = list(c.execute("""select id, coalesce(user_set_name,'') , coalesce(name,''), created_at, updated_at,
 provider_name, coalesce(model_config_json,''), coalesce(accumulated_cost,0), coalesce(accumulated_total_tokens,0)
 from sessions"""))
out['n_sesiones'] = len(sess)
print(f"TOTAL sesiones: {len(sess)}")

# ---- 2) ledger agregado por sesión ----
agg = {}
for r in c.execute("""select session_id, count(*), sum(input_tokens), sum(output_tokens), sum(total_tokens),
 sum(cache_read_tokens), sum(cost), min(created_timestamp), max(created_timestamp), sum(is_compaction)
 from usage_ledger group by session_id"""):
    agg[r[0]] = {'llamadas': r[1], 'in': r[2] or 0, 'out': r[3] or 0, 'tot': r[4] or 0, 'cache_r': r[5] or 0,
                 'costo': round(r[6] or 0, 6), 't0': r[7], 't1': r[8], 'compactions': r[9]}
models = collections.defaultdict(collections.Counter)
for sid, m, n in c.execute("select session_id, model, count(*) from usage_ledger group by session_id, model"):
    models[sid][m or '?'] = n
out['ledger'] = agg

# ---- 3) mensajes por sesión ----
msgs = {}
for r in c.execute("""select session_id, count(*), sum(length(content_json)), sum(coalesce(tokens,0))
 from messages group by session_id"""):
    msgs[r[0]] = {'n': r[1], 'bytes': r[2] or 0, 'tokens_msg': r[3] or 0}
out['mensajes'] = msgs

midnight = datetime.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)

print()
print("== SESIONES CON ACTIVIDAD HOY (por tokens totales; local) ==")
print(f"{'id':16} {'nombre':30} {'msgs':>5} {'llam':>4} {'tot_tok':>10} {'in':>9} {'out':>7} {'cache%':>6} {'costo$':>9} {'dur':>6} {'desde':>10} {'hasta':>5} {'comp':>4} modelo")
rows = []
for s in sess:
    sid = s[0]
    a = agg.get(sid)
    if not a: continue
    t1l = a['t1']
    if t1l and datetime.datetime.fromtimestamp(t1l, TZ) >= midnight:
        rows.append((a['tot'], sid, s, a))
rows.sort(reverse=True, key=lambda x: x[0])
tot_calls = tot_in = tot_out = tot_cache = 0
tot_cost = 0.0
for tot, sid, s, a in rows:
    m = msgs.get(sid, {'n': 0})
    cache_pct = (a['cache_r'] / a['in'] * 100) if a['in'] else 0
    dur = (a['t1'] - a['t0']) / 60 if a['t0'] and a['t1'] else 0
    mods = ','.join(f"{k}:{v}" for k, v in models.get(sid, {}).most_common(2))
    nm = str(s[1] or s[2] or '?')[:30]
    print(f"{sid:16} {nm:30} {m['n']:>5} {a['llamadas']:>4} {a['tot']:>10} {a['in']:>9} {a['out']:>7} {cache_pct:>5.1f}% {a['costo']:>9.4f} {dur:>5.0f}m {hm(a['t0']):>5} {hm(a['t1']):>5} {a['compactions']:>4} {mods}")
    tot_calls += a['llamadas']; tot_in += a['in']; tot_out += a['out']; tot_cache += a['cache_r']; tot_cost += a['costo']
print(f"{'TOTALES HOY':16} {'':30} {'':>5} {tot_calls:>4} {tot_in+tot_out:>10} {tot_in:>9} {tot_out:>7} {(tot_cache/tot_in*100 if tot_in else 0):>5.1f}% {tot_cost:>9.4f}")
out['hoy'] = {'llamadas': tot_calls, 'in': tot_in, 'out': tot_out, 'cache_r': tot_cache, 'costo': round(tot_cost, 6),
              'sesiones': [{'id': sid, 'nombre': s[1] or s[2], 'msg': msgs.get(sid, {}).get('n', 0), **{k: v for k, v in a.items() if k != 't0' and k != 't1'}, 't0': a['t0'], 't1': a['t1']} for _, sid, s, a in rows]}

# ---- 4) top consumidores de TODA la base ----
print()
print("== TOP 10 sesiones por tokens (histórico) ==")
allr = sorted([(v['tot'], k) for k, v in agg.items()], reverse=True)[:10]
for tot, sid in allr:
    nm = str(next(((s[1] or s[2]) for s in sess if s[0] == sid), '?') or '?')[:32]
    a = agg[sid]
    print(f"{sid:16} {str(nm)[:32]:32} tok={tot:>11} llam={a['llamadas']:>4} costo=${a['costo']:.3f} hasta={loc(a['t1'])}")

# ---- 5) compactaciones ----
print()
print("== compactaciones (is_compaction=1) ==")
for r in c.execute("select session_id, count(*), sum(input_tokens) from usage_ledger where is_compaction=1 group by session_id order by 2 desc limit 10"):
    print(r)
ncomp = c.execute("select count(*) from usage_ledger where is_compaction=1").fetchone()[0]
print("total:", ncomp)

# ---- 6) turn-context (overhead por paso) ----
print()
print("== turn-context: bloques y bytes ==")
for r in c.execute("""select session_id, count(*), sum(length(content_json)) from messages
 where content_json like '%<turn-context>%' group by session_id order by 3 desc limit 8"""):
    print(r)

# ---- 7) tokens por mensaje (columna tokens) ----
print()
print("== messages.tokens (top 5 mensajes por tokens, hoy) ==")
for r in c.execute("""select id, session_id, role, tokens, length(content_json), substr(content_json,1,100)
 from messages where coalesce(tokens,0) > 0 order by tokens desc limit 5"""):
    print(f"id={r[0]} ses={r[1]} {r[2]} tok={r[3]} bytes={r[4]} | {r[5][:90]!r}")

with open('C:/goose-web/tools/session-analysis.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1, default=str)
print()
print("JSON completo: C:/goose-web/tools/session-analysis.json")

import sqlite3, os, json, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
db = os.path.expandvars(r'%APPDATA%\Aegis\aegis\data\sessions\sessions.db').replace('\\', '/')
con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
cur = con.cursor()
for sid in ('20261014_15', '20261014_8', '20261014_14'):
    print('==== session', sid)
    rows = list(cur.execute(
        "SELECT role, timestamp, content_json FROM messages WHERE session_id=? "
        "ORDER BY id DESC LIMIT 40", (sid,)))
    out = []
    for role, ts, cj in rows:
        if role != 'user':
            continue
        try:
            parts = json.loads(cj)
        except Exception:
            continue
        txt = ''
        for p in parts:
            if p.get('type') == 'text':
                txt += p.get('text', '')
        txt = txt.strip()
        if not txt or txt.startswith('<turn-context>'):
            continue
        out.append((ts, txt[:200].replace('\n', ' ')))
    for ts, t in reversed(out[-8:]):
        print(ts, '|', t)

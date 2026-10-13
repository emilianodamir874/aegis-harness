import io, sys, json
P='C:/goose/crates/goose/src/acp/server.rs'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
raw = rd(P)
new = None
for old, n in json.loads(rd('C:/goose-web/tools/_pairs.json')):
    if raw.count(old) == 1: new = n; break
if new is None:
    print('FAIL: no matcheo el Drop del guard'); sys.exit(1)
old = [o for o, _ in json.loads(rd('C:/goose-web/tools/_pairs.json')) if raw.count(o) == 1][0]
with io.open(P,'w',encoding='utf-8',newline='') as f: f.write(raw.replace(old, new))
print('OK guard sin cancel')
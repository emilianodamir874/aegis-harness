import io, sys, json
APP='C:/goose-web/app/app.js'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
def wr(p,s):
    with io.open(p,'w',encoding='utf-8',newline='') as f: f.write(s)
raw = rd(APP)
new = None
for old, n in json.loads(rd('C:/goose-web/tools/_pairs.json')):
    if raw.count(old) == 1: new = n; break
if new is None: print('FAIL: no encontre la linea de initialize'); sys.exit(1)
old = [o for o, _ in json.loads(rd('C:/goose-web/tools/_pairs.json')) if raw.count(o) == 1][0]
wr(APP, raw.replace(old, new))
print('OK capability toolCallLabelEnrichment')
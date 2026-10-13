import io, sys, json
APP='C:/goose-web/app/app.js'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
def wr(p,s):
    with io.open(p,'w',encoding='utf-8',newline='') as f: f.write(s)
raw = rd(APP)
for old, new in json.loads(rd('C:/goose-web/tools/_pairs.json')):
    c = raw.count(old)
    if c != 1:
        print('FAIL count=%d %r' % (c, old[:70])); sys.exit(1)
    raw = raw.replace(old, new)
wr(APP, raw)
print('OK titulo+icono')
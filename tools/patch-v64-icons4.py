import io, sys, json
APP='C:/goose-web/app/app.js'; CSSF='C:/goose-web/app/app.css'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
def wr(p,s):
    with io.open(p,'w',encoding='utf-8',newline='') as f: f.write(s)
raw = rd(APP)
pairs = json.loads(rd('C:/goose-web/tools/_pairs.json'))
def apply(old, new):
    global raw
    for o, n in ((old, new), (old.replace(chr(10), chr(13)+chr(10)), new.replace(chr(10), chr(13)+chr(10)))):
        c = raw.count(o)
        if c == 1:
            raw = raw.replace(o, n); return True
        if c > 1:
            print('FAIL ambiguo count=%d %r' % (c, o[:60])); sys.exit(1)
    print('FAIL no encontrado: %r' % old[:80]); sys.exit(1)
for old, new in pairs:
    apply(old, new)
k = raw.index('  function toolUpsert(')
raw = raw[:k] + rd('C:/goose-web/tools/_icons.js') + raw[k:]
fab = rd('C:/goose-web/tools/_fab.js')
anchor = '  if (!window.__usagePopKeys) {'
if raw.count(anchor) != 1: print('FAIL fab anchor'); sys.exit(1)
nl = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
raw = raw.replace(anchor, fab + nl + nl + anchor)
wr(APP, raw)
wr(CSSF, rd(CSSF) + rd('C:/goose-web/tools/_icons.css'))
print('OK iconos+animaciones+cache')
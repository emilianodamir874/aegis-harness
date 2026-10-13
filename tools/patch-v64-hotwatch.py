import io, sys, json
APP='C:/goose-web/app/app.js'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
def wr(p,s):
    with io.open(p,'w',encoding='utf-8',newline='') as f: f.write(s)
raw = rd(APP)
for old, new in json.loads(rd('C:/goose-web/tools/_pairs.json')):
    if raw.count(old) != 1: print('FAIL count=%d' % raw.count(old)); sys.exit(1)
    raw = raw.replace(old, new)
anchor = '  async function resyncAdoptedRun() {'
if raw.count(anchor) != 1: print('FAIL anchor hot'); sys.exit(1)
raw = raw.replace(anchor, rd('C:/goose-web/tools/_hot.js') + anchor)
wr(APP, raw)
print('OK hot watch')
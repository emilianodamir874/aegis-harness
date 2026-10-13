import io, sys
APP='C:/goose-web/app/app.js'; CSS='C:/goose-web/app/app.css'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
def wr(p,s):
    with io.open(p,'w',encoding='utf-8',newline='') as f: f.write(s)
raw = rd(APP)
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
NEWJS = rd('C:/goose-web/tools/_usagepop.js').split(chr(10))
MODELS = rd('C:/goose-web/tools/_modelsummary.js').split(chr(10))
# 1) reemplazar modelSummary por modelParts + modelSummary
lines = raw.split(SEP)
idx = [i for i,l in enumerate(lines) if l.startswith('  function modelSummary() {')]
if len(idx) != 1: print('FAIL modelSummary %d' % len(idx)); sys.exit(1)
i = idx[0]; j = i
while lines[j] != '  }':
    j += 1
lines[i:j+1] = MODELS
# 2) insertar el panel antes de renderUsage
k = [i for i,l in enumerate(lines) if l.startswith('  function renderUsage() {')]
if len(k) != 1: print('FAIL renderUsage %d' % len(k)); sys.exit(1)
lines[k[0]:k[0]] = NEWJS
# 3) el click abre el panel, no un systemNote
c = [i for i,l in enumerate(lines) if 'el.onclick = () => { systemNote(' in l]
if len(c) != 1: print('FAIL onclick %d' % len(c)); sys.exit(1)
lines[c[0]] = "    el.onclick = () => openUsagePop();"
wr(APP, SEP.join(lines))
# 4) CSS
css = rd(CSS) + chr(10) + rd('C:/goose-web/tools/_usagepop.css')
wr(CSS, css)
print('OK panel + css')

import io, sys
APP='C:/goose-web/app/app.js'; CSSF='C:/goose-web/app/app.css'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
def wr(p,s):
    with io.open(p,'w',encoding='utf-8',newline='') as f: f.write(s)
raw = rd(APP)
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
lines = raw.split(SEP)
NEW = rd('C:/goose-web/tools/_pop2.js').split(chr(10))
h = [i for i,l in enumerate(lines) if l.startswith('  // ---------- panel de contexto')]
e = [i for i,l in enumerate(lines) if l.startswith('  function renderUsage() {')]
if len(h)!=1 or len(e)!=1: print('FAIL h=%d e=%d' % (len(h), len(e))); sys.exit(1)
print('reemplazando lineas %d..%d (%d)' % (h[0]+1, e[0], e[0]-h[0]))
lines[h[0]:e[0]] = NEW
wr(APP, SEP.join(lines))
css = rd(CSSF)
mk = css.find('/* ---------- panel de uso/contexto')
if mk < 0: print('FAIL marcador css'); sys.exit(1)
wr(CSSF, css[:mk] + rd('C:/goose-web/tools/_pop2.css').lstrip(chr(10)))
print('OK popover -> %d lineas' % len(lines))

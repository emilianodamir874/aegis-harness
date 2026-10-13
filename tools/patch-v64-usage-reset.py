import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
lines = raw.split(SEP)
def find(p, expect=1):
    idx = [i for i,l in enumerate(lines) if l.startswith(p)]
    if len(idx) != expect:
        print('FAIL find %r -> %d' % (p, len(idx))); sys.exit(1)
    return idx[0]
i = find('  async function openSession(entry) {')
lines[i+1:i+1] = ["    state.usage = {}; renderUsage(); // el readout de uso es POR SESION: no arrastrar el de la anterior"]
with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(SEP.join(lines))
print('OK openSession reset -> %d' % len(lines))

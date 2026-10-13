import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
lines = raw.split(SEP)
idx = [i for i,l in enumerate(lines) if l.startswith('  function setUsage(u) {')]
print('setUsage defs:', [i+1 for i in idx])
if len(idx) != 2:
    print('FAIL: esperaba 2 definiciones'); sys.exit(1)
i = idx[1]  # la vieja (posterior en el archivo: shadowea)
j = i
while lines[j] != '  }':
    j += 1
    if j - i > 20: print('FAIL fin'); sys.exit(1)
print('borrando lineas %d..%d' % (i+1, j+1))
del lines[i:j+1]
with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(SEP.join(lines))
print('OK -> %d lineas' % len(lines))

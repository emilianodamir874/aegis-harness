import io, sys
P='C:/goose-web/app/app.js'
with io.open(P,'r',encoding='utf-8',newline='') as f: raw=f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
lines = raw.split(SEP)
k = [i for i,l in enumerate(lines) if l.startswith('    updateMetaHints();')]
if len(k) < 1: print('FAIL'); sys.exit(1)
# el último updateMetaHints del replay (dentro de renderSession): resetear ahi, con state.current ya seteado
last = k[-1]
lines[last+1:last+1] = ["    resetUsageForSession(); // ya con state.current apuntando a ESTA sesion"]
with io.open(P,'w',encoding='utf-8',newline='') as f: f.write(SEP.join(lines))
print('OK reset al final del render')

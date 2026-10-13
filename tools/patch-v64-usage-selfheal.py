import io, sys
P='C:/goose-web/app/app.js'
with io.open(P,'r',encoding='utf-8',newline='') as f: raw=f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
def rep(old, new):
    global raw
    if raw.count(old) != 1:
        print('FAIL count=%d %r' % (raw.count(old), old[:60])); sys.exit(1)
    raw = raw.replace(old, new)
# auto-sanador: cualquier update de uso primero asegura que el estado sea de ESTA sesion
rep("    dbg.setUsage++; dbg.lastSet = u;" + SEP + "    const s = state.usage || (state.usage = {});",
    "    dbg.setUsage++; dbg.lastSet = u;" + SEP +
    "    resetUsageForSession(); // si cambiaste de chat, no mezclar el uso de la anterior" + SEP +
    "    const s = state.usage || (state.usage = {});")
rep("    dbg.setMsgUsage++; dbg.lastMsg = u;" + SEP + "    const s = state.usage || (state.usage = {});",
    "    dbg.setMsgUsage++; dbg.lastMsg = u;" + SEP +
    "    resetUsageForSession();" + SEP +
    "    const s = state.usage || (state.usage = {});")
with io.open(P,'w',encoding='utf-8',newline='') as f: f.write(raw)
print('OK reset autosanador')

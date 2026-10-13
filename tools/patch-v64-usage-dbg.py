import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
def rep(old, new, expect=1):
    global raw
    if raw.count(old) != expect:
        print('FAIL count=%d for %r' % (raw.count(old), old[:70])); sys.exit(1)
    raw = raw.replace(old, new)

# A) instrumentacion en los dos setters
rep("  function setUsage(u) {" + SEP + "    const s = state.usage || (state.usage = {});",
    "  function setUsage(u) {" + SEP +
    "    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, lastSet: null, lastMsg: null });" + SEP +
    "    dbg.setUsage++; dbg.lastSet = u;" + SEP +
    "    const s = state.usage || (state.usage = {});")
rep("  function setMsgUsage(u) {" + SEP + "    const s = state.usage || (state.usage = {});",
    "  function setMsgUsage(u) {" + SEP +
    "    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, lastSet: null, lastMsg: null });" + SEP +
    "    dbg.setMsgUsage++; dbg.lastMsg = u;" + SEP +
    "    const s = state.usage || (state.usage = {});")

# B) reset por sesion (no pisar el de la misma sesion al re-abrir)
rep("    state.usage = {}; renderUsage(); // el readout de uso es POR SESION: no arrastrar el de la anterior",
    "    resetUsageForSession();")
rep("  function renderUsage() {",
    "  function resetUsageForSession() {" + SEP +
    "    const sid = (state.current && state.current.id) || null;" + SEP +
    "    if (state.usageSid === sid) return;" + SEP +
    "    state.usageSid = sid;" + SEP +
    "    state.usage = {};" + SEP +
    "    renderUsage();" + SEP +
    "  }" + SEP +
    "  function renderUsage() {")

# C) exponer para depuracion
rep("  window.__gooseWeb = { state, ",
    "  window.__gooseWeb = { state, usageDbg: () => state.usageDbg, usageState: () => state.usage, usageLines: () => usageLines(), usageReset: resetUsageForSession, ")

with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(raw)
print('OK instrumentado')

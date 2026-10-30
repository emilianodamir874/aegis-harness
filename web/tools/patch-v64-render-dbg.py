import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
def rep(old, new, expect=1):
    global raw
    if raw.count(old) != expect:
        print('FAIL count=%d %r' % (raw.count(old), old[:60])); sys.exit(1)
    raw = raw.replace(old, new)
rep("  function renderUsage() {" + SEP + "    const el = $('#meta-right');" + SEP + "    if (!el) return;",
    "  function renderUsage() {" + SEP +
    "    const el = $('#meta-right');" + SEP +
    "    if (!el) return;" + SEP +
    "    const dbg = state.usageDbg || (state.usageDbg = { setUsage: 0, setMsgUsage: 0, render: 0, lastSet: null, lastMsg: null });" + SEP +
    "    dbg.render++;")
rep("  window.__aegisWeb = { state, ",
    "  window.__aegisWeb = { state, renderUsagePublic: renderUsage, metaRight: () => $('#meta-right'), ")
with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(raw)
print('OK render dbg')

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
NEW = io.open('C:/goose-web/tools/_newusage.txt','r',encoding='utf-8').read().split(chr(10))
# 1) setUsage -> bloque nuevo
i = find('  function setUsage(u) {')
j = i
while lines[j] != '  }':
    j += 1
    if j - i > 20: print('FAIL setUsage end'); sys.exit(1)
# 2) case message_usage en el dispatcher
k = find("      case 'usage_update':")
assert lines[k+1].strip() == 'setUsage(u);' and lines[k+2].strip() == 'break;'
# 3) onAegisUpdate
m = find("    if (u.sessionUpdate === 'usage_update') setUsage(u);")
for pos, txt in sorted([(m+1, ["    if (u.sessionUpdate === 'message_usage') setMsgUsage(u.usage);"]),
                        (k+3, ["      case 'message_usage':", "        setMsgUsage(u.usage);", "        break;"]),
                        (i, NEW), (j+1, [])], key=lambda x: -x[0]):
    lines[pos:pos] = txt
with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(SEP.join(lines))
print('OK usage -> %d lines' % len(lines))

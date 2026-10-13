import io
P='C:/goose-web/app/app.css'
with io.open(P,'r',encoding='utf-8',newline='') as f: raw=f.read()
old = '.tool-ic::before { content: none; }'
new = '.tool-ic::before, .tool.ok .tool-ic::before, .tool.err .tool-ic::before { content: none; }'
if raw.count(old) != 1: print('FAIL'); raise SystemExit(1)
with io.open(P,'w',encoding='utf-8',newline='') as f: f.write(raw.replace(old, new))
print('OK')
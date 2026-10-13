import io
P='C:/goose/ui/desktop/scripts/goose-web-reload3.mjs'
with io.open(P,'r',encoding='utf-8',newline='') as f: raw=f.read()
old = "await page.waitForTimeout(30000);\nawait snap('POST44 ');"
new = "await page.waitForTimeout(70000);\nawait snap('POST84 ');"
if raw.count(old) != 1: print('FAIL', raw.count(old)); raise SystemExit(1)
with io.open(P,'w',encoding='utf-8',newline='') as f: f.write(raw.replace(old,new))
print('ok')
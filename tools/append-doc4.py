import io
P='C:/goose-web/docs/v6.3-serve-v3.md'
tail = io.open('C:/goose-web/tools/_docicons.txt','r',encoding='utf-8').read()
with io.open(P,'a',encoding='utf-8',newline='') as f: f.write(tail)
print('OK doc iconos')
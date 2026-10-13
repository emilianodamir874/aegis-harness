import io
P = 'C:/goose-web/docs/v6.3-serve-v3.md'
with io.open(P, 'a', encoding='utf-8', newline='') as f:
    f.write(open('C:/goose-web/tools/_doctail.txt','r',encoding='utf-8').read())
print('OK doc')

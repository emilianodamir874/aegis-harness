import io, sys
CSSF='C:/goose-web/app/app.css'
with io.open(CSSF,'r',encoding='utf-8',newline='') as f: raw=f.read()
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
with io.open('C:/goose-web/tools/_claude.css','r',encoding='utf-8') as f: block=f.read()
if 'rediseno "Claude-like"' in raw:
    print('ya aplicado'); sys.exit(0)
with io.open(CSSF,'w',encoding='utf-8',newline='') as f: f.write(raw + block)
print('OK css claude-like')

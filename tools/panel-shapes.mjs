// Muestra la forma real de los endpoints JSON que consumen los paneles del cliente React.
// Uso: node tools/panel-shapes.mjs http://127.0.0.1:3790
const base = process.argv[2] || 'http://127.0.0.1:3790';
const paths = ['/changes.json', '/outbox.json', '/memory.json', '/doctor.json', '/stats.json', '/goals.json', '/pending.json', '/ws/list?limit=3'];

const describe = (value, depth = 0) => {
  if (Array.isArray(value)) {
    const first = value[0];
    return `array(${value.length})${first !== undefined && depth < 2 ? ` of {${Object.keys(first).slice(0, 14).join(',')}}` : ''}`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    return `object{${keys.slice(0, 16).join(',')}${keys.length > 16 ? ',…' : ''}}`;
  }
  return typeof value;
};

for (const path of paths) {
  const started = Date.now();
  try {
    const response = await fetch(base + path, { headers: { accept: 'application/json' } });
    const text = await response.text();
    const ms = Date.now() - started;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      console.log(`${path} -> ${response.status} non-json (${text.slice(0, 60).replace(/\s+/g, ' ')}) ${ms}ms`);
      continue;
    }
    const top = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    const arrays = top.filter((k) => Array.isArray(body[k])).map((k) => `${k}=${describe(body[k])}`);
    console.log(`${path} -> ${response.status} ${ms}ms top{${top.slice(0, 18).join(',')}} ${arrays.join(' ')}`);
    if (Array.isArray(body) || (body.results && Array.isArray(body.results))) {
      const sample = Array.isArray(body) ? body[0] : body.results[0];
      if (sample) console.log(`   sample {${Object.keys(sample).slice(0, 14).join(',')}}`);
    }
  } catch (error) {
    console.log(`${path} -> FAIL ${(error && error.message) || error}`);
  }
}

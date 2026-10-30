import { chromium } from 'playwright';

const url = (process.argv[2] || process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForFunction(() => window.__aegisWeb?.chips, null, { timeout: 20000 });
  await page.waitForTimeout(1000);

  const res = await page.evaluate(async () => {
    const w = window.__aegisWeb;
    w.__probe = { calls: [] };
    w.state.current = {
      id: 'codex-test-session',
      title: 'Codex Session',
      configOptions: [
        { id: 'provider', currentValue: 'chatgpt_codex', options: [{ value: 'chatgpt_codex', name: 'ChatGPT Codex' }] },
        { id: 'model', currentValue: 'gpt-6-sol', options: [{ value: 'gpt-6-sol', name: 'GPT-6 Sol' }] },
        { id: 'mode', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] },
        { id: 'codex_fast_mode', currentValue: 'off', options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'Fast' }] },
      ],
    };
    w.chips.setAplicar((configId, value) => {
      w.__probe.calls.push(configId + '=' + value);
      const opt = w.state.current.configOptions.find((o) => o.id === configId);
      if (opt) opt.currentValue = value;
      w.chips.render();
    });
    w.chips.render();

    const btn1 = document.getElementById('btn-codex-fast');
    const visible1 = !!btn1;
    const text1 = btn1 ? btn1.textContent.trim() : '';
    const pressed1 = btn1 ? btn1.getAttribute('aria-pressed') : '';

    if (btn1) btn1.click();
    await new Promise((r) => setTimeout(r, 100));

    const btn2 = document.getElementById('btn-codex-fast');
    const text2 = btn2 ? btn2.textContent.trim() : '';
    const pressed2 = btn2 ? btn2.getAttribute('aria-pressed') : '';

    if (btn2) btn2.click();
    await new Promise((r) => setTimeout(r, 100));

    // Cambiar a open_design para asegurar que el botón desaparece
    w.state.current.configOptions[0].currentValue = 'open_design';
    w.chips.render();
    const btnHidden = !document.getElementById('btn-codex-fast');

    return {
      visible1,
      text1,
      pressed1,
      text2,
      pressed2,
      calls: w.__probe.calls,
      btnHidden,
    };
  });

  console.log(JSON.stringify(res, null, 2));
  if (!res.visible1 || res.text1 !== 'Fast apagado' || res.text2 !== 'Fast' || !res.btnHidden) {
    process.exit(1);
  }
} finally {
  await browser.close();
}

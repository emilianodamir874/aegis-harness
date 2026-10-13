// goose-web chat e2e: dismisses the first-run modal, sends a message in the
// default chat and captures the streamed answer. Requires the web stack up.
// Run:  cd ui/desktop && node scripts/web-chat-check.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const prompt = process.env.WEB_CHAT_PROMPT || 'Respondé exactamente: PONG. Nada más.';

const logs = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`.slice(0, 240)));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e && e.message).slice(0, 240)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url().slice(0, 160)}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Dismiss the first-run / announcement modal if present.
  for (const label of ['Cerrar', 'No, gracias', 'Close']) {
    const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
    try {
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        logs.push(`[ui] dismissed modal via "${label}"`);
        break;
      }
    } catch {
      /* keep trying */
    }
  }
  await page.waitForTimeout(500);

  // Force a fresh chat so the composer is on a new session.
  try {
    const nuevo = page.getByText('Nuevo chat', { exact: true }).first();
    if (await nuevo.isVisible({ timeout: 2500 })) {
      await nuevo.click();
      logs.push('[ui] clicked Nuevo chat');
      await page.waitForTimeout(1500);
    }
  } catch {
    logs.push('[ui] Nuevo chat not found; sending from current view');
  }

  // Find the composer and send the prompt.
  const box = page.locator('textarea, [contenteditable="true"], input[type="text"]').first();
  await box.waitFor({ state: 'visible', timeout: 15000 });
  await box.click();
  await box.fill(prompt);
  await page.keyboard.press('Enter');
  logs.push('[ui] prompt sent');

  // Wait for the answer to stream in (PONG appears twice: user echo + answer).
  const deadline = Date.now() + 180000;
  let text = '';
  let pongCount = 0;
  while (Date.now() < deadline) {
    text = await page.evaluate(() => document.body.innerText || '');
    pongCount = (text.match(/\bPONG\b/g) || []).length;
    if (pongCount >= 2) break;
    await page.waitForTimeout(2500);
  }

  console.log(
    JSON.stringify(
      {
        sent: prompt,
        sawPongAnswer: pongCount >= 2,
        pongCount,
        tail: text.slice(-1500),
        logs: logs.slice(0, 80),
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}

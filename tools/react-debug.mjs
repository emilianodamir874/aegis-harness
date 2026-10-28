// Diagnóstico: abre el cliente con el bundle de desarrollo de Vite y reporta el stack real.
// Uso: node tools/react-debug.mjs http://127.0.0.1:5174/app-react/?acp=proxy
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:5174/?acp=proxy';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => {
  console.log('PAGEERROR', error.message);
  console.log(error.stack?.split('\n').slice(0, 12).join('\n'));
});
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') console.log(message.type().toUpperCase(), message.text().slice(0, 800));
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(6000);
console.log('title:', await page.title());
await browser.close();

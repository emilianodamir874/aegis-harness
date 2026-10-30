// Helpers compartidos por las pruebas de aegis-web.
// URL objetivo: AEGIS_WEB_URL (default http://127.0.0.1:3788, la web viva).
export function baseUrl(): string {
  return (process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788').replace(/\/+$/, '');
}

export function acpEndpoint(): string {
  return process.env.AEGIS_ACP_URL || 'ws://127.0.0.1:3284/acp';
}

export function fail(msg: string): never {
  console.error('FAIL ' + msg);
  process.exit(1);
}

export function pass(msg: string): void {
  console.log('PASS ' + msg);
}

export function check(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

export async function openPage(browser: any, opts: Record<string, unknown> = {}): Promise<any> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...opts });
  return ctx.newPage();
}

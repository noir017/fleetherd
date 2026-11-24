import {
  test as base,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from '@playwright/test';

function parseCdpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const headers: Record<string, string> = {};
  if (trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('PW_CDP_HEADERS JSON must be an object of header key/value pairs');
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') headers[key] = value;
    }
    return headers;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// When PW_CDP_URL is set, attach to a remote Chromium over CDP and isolate each test in its own context.
// Otherwise keep Playwright's built-in browser/context fixtures so traces, screenshots, and video work natively.
const cdpUrl = process.env.PW_CDP_URL;

export const test = cdpUrl
  ? base.extend({
      browser: [
        async ({}, use) => {
          const headers = parseCdpHeaders(process.env.PW_CDP_HEADERS);
          const remote = await chromium.connectOverCDP(cdpUrl, headers ? { headers } : undefined);
          await use(remote);
        },
        { scope: 'worker' },
      ],
      context: async ({ browser, viewport }, use) => {
        const context: BrowserContext = await browser.newContext(viewport ? { viewport } : {});
        try {
          await use(context);
        } finally {
          await context.close();
        }
      },
    })
  : base;

export { expect };

export async function loginViaUi(page: Page, baseUrl: string, secret: string): Promise<void> {
  await page.goto(baseUrl);
  await expect(page.locator('#gate')).toBeVisible();
  await page.locator('#secret').fill(secret);
  await page.locator('#gate button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#gate')).toBeHidden();
}

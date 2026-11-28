import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, loginViaUi, test } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

// app-*.js is built without en-extras / zh-CN-extras (scripts/webui-client.mjs): the extras chunk
// brings them, for its own modules and for the page's i18n that plugins reach through ctx.i18n.
// A string from either route that showed as its key would be the split gone wrong.
const I18N_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/webui/client/i18n');
const dict = (file: string): Record<string, string> => {
  const src = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
  return Object.fromEntries([...src.matchAll(/^\s*'([^']+)':\s*'([^']*)',$/gm)].map((m) => [m[1]!, m[2]!]));
};
const EXTRAS = { en: dict('en-extras.ts'), 'zh-CN': dict('zh-CN-extras.ts') } as const;
const TOPIC_TITLE = 'Extras strings topic';

let gateway: GatewayHandle;
let topicId = '';

async function rawKeys(page: Page): Promise<string[]> {
  return page.evaluate((keys) => {
    const known = new Set(keys);
    const found = new Set<string>();
    const scan = (text: string | null | undefined): void => {
      for (const m of (text ?? '').matchAll(/[A-Za-z0-9_]+\.[A-Za-z0-9_.]+/g)) if (known.has(m[0])) found.add(m[0]);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) scan(node.textContent);
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      for (const attr of ['title', 'aria-label', 'placeholder']) scan(el.getAttribute(attr));
    }
    return [...found];
  }, Object.keys(EXTRAS.en));
}

test.describe('extras chunk strings', () => {
  test.beforeAll(async () => {
    gateway = await startGateway({ title: 'fleetherd-i18n-extras-e2e' });
    const seeded = await seedTopics(gateway, [{ title: TOPIC_TITLE, message: 'Look at the workspace.' }]);
    topicId = seeded.topics[TOPIC_TITLE] ?? '';
    await fetch(`${gateway.baseUrl}/api/schedules/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seeded.cookie },
      body: JSON.stringify({
        task: { name: 'nightly-report', prompt: 'Summarize.', agent: 'alpha', session: 'new', cron: '0 2 * * *', tz: 'UTC', target: { topic: topicId } },
      }),
    });
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  for (const locale of ['en', 'zh-CN'] as const) {
    test(`every lazily loaded view shows its strings in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript((lang) => localStorage.setItem('fh_lang', lang), locale);
      await loginViaUi(page, gateway.baseUrl, gateway.secret);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const seen = new Set<string>();
      const check = async (): Promise<void> => {
        for (const key of await rawKeys(page)) seen.add(key);
      };

      await page.locator('.wb-activity-item[data-activity-id="schedules"]').click();
      await expect(page.getByPlaceholder(EXTRAS[locale]['sched.searchTasks']!)).toBeVisible();
      await page.locator('.fh-schedules-view .sched-row').first().click();
      await expect(page.locator('.fh-schedule-editor .tp-view')).toBeVisible();
      await check();

      await page.locator('.wb-activity-item[data-activity-id="history"]').click();
      await page.locator('.wb-history-view .hist-item').first().click();
      await expect(page.locator('.wb-history-editor .wb-history-head')).toBeVisible();
      await check();

      await page.locator('.wb-activity-item[data-activity-id="reviews"]').click();
      await expect(page.locator('.fh-reviews-view')).toBeVisible();
      await check();

      await page.locator('.wb-activity-item[data-activity-id="skills"]').click();
      await expect(page.locator('.fh-skills-view')).toBeVisible();
      await check();

      await page.locator('.wb-activity-item[data-activity-id="settings"]').click();
      await page.locator('.wb-set-catalog [role="option"]').first().click();
      await expect(page.locator('.wb-set-editor:visible .wb-set-gateway .set-card, .wb-set-editor:visible .wb-set-gateway .ag-card').first()).toBeVisible({ timeout: 15_000 });
      await check();
      await page.locator('.wb-set-catalog [role="option"]', { hasText: /指令文件|Instruction files/ }).click();
      await expect(page.locator('.wb-instr-tree .fx-row').first()).toBeVisible({ timeout: 10_000 });
      await check();

      await page.locator('.wb-activity-item[data-activity-id="topics"]').click();
      await page.locator(`#topics .topic-item[data-topic="${topicId}"]`).click();
      await page.locator('[data-tool-id="changes"]').first().click();
      await expect(page.locator('.fh-changes-tool')).toBeVisible();
      await check();
      await page.locator('[data-tool-id="files"]').first().click();
      // Resolved through ctx.i18n, i.e. the page's own dictionaries, which the chunk extended.
      await expect(page.getByPlaceholder(EXTRAS[locale]['files.searchPlaceholder']!)).toBeVisible();
      await check();

      expect([...seen]).toEqual([]);
    });
  }
});

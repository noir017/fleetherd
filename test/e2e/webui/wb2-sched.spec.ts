import { expect, loginViaUi, test } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;
let cookie = '';

test.describe('wb2-sched schedules, history, and reviews alignment', () => {
  test.beforeAll(async () => {
    gateway = await startGateway({ title: 'fleetherd-wb2-sched-e2e' });
    const seeded = await seedTopics(gateway, [
      { title: 'Node 22 upgrade', message: 'Check Node 22 upgrade steps.' },
      { title: 'Slow cart API', message: 'Inspect slow cart API queries.' },
    ]);
    cookie = seeded.cookie;
    const targetTopic = seeded.topics['Node 22 upgrade'];

    await fetch(`${gateway.baseUrl}/api/schedules/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        task: {
          name: 'nightly-ci-report',
          prompt: 'Summarize failing CI jobs.',
          agent: 'alpha',
          session: 'new',
          cron: '0 2 * * *',
          tz: 'UTC',
          target: { topic: targetTopic },
          tags: ['ci'],
        },
      }),
    });
  });

  test.afterAll(async () => {
    await gateway.stop();
  });

  test('desktop renders schedules detail/edit/sessions, grouped history + read-only footer, and reviews', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    // Schedules: Tasks + Detail + Edit + Sessions
    await page.locator('.wb-activity-item[data-activity-id="schedules"]').click();
    const taskRow = page.locator('.fh-schedules-view .sched-row').first();
    await expect(taskRow).toBeVisible();
    await taskRow.click();
    await expect(page.locator('.fh-schedule-editor .tp-view')).toBeVisible();
    await expect(page.locator('.fh-schedule-editor .fh-psub')).toBeVisible();
    await expect(page.locator('.fh-schedule-editor .tp-prompt-card')).toBeVisible();

    await page.locator('.fh-schedule-editor .tp-acts--head [data-tp-act="edit"]').click();
    await expect(page.locator('#tp-form')).toBeVisible();
    await page.locator('.fh-schedule-editor .tp-acts--head button').first().click();
    await expect(page.locator('.fh-schedule-editor .tp-view')).toBeVisible();

    await page.locator('.fh-schedules-subnav button').nth(1).click();
    await expect(page.locator('.fh-schedules-sess-search')).toBeVisible();

    // History: date groups + read-only editor footer
    await page.locator('.wb-activity-item[data-activity-id="history"]').click();
    await expect(page.locator('.wb-history-grp').first()).toBeVisible();
    await page.locator('.wb-history-view .hist-item').first().click();
    await expect(page.locator('.wb-history-editor .wb-history-head')).toBeVisible();
    await expect(page.locator('.wb-history-editor .wb-history-foot')).toBeVisible();

    // Reviews view loads cleanly
    await page.locator('.wb-activity-item[data-activity-id="reviews"]').click();
    await expect(page.locator('.fh-reviews-view')).toBeVisible();
  });

  test('mobile drawer renders history and schedules lists without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();

    await page.locator('.wb-activity-item[data-activity-id="history"]').click();
    await expect(page.locator('.wb-history-view .hist-item').first()).toBeVisible();
    const histOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(histOverflow).toBe(false);

    await page.locator('.wb-activity-item[data-activity-id="schedules"]').click();
    await expect(page.locator('.fh-schedules-view .sched-row').first()).toBeVisible();
    const schedOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(schedOverflow).toBe(false);
  });
});

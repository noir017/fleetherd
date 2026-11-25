import crypto from 'node:crypto';
import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;

test.describe('Web UI mobile shell, palette, and login alignment', () => {
  test.beforeAll(async () => {
    gateway = await startGateway({ title: 'fleetherd' });
    await seedTopics(gateway, [
      { title: 'Refactor webui panels', message: 'Check mobile shell and tokens.', starred: true },
      { title: 'Slow cart API', message: 'Inspect latency logs.' },
    ]);
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('login card shows logo, title, subtitle, error feedback, and admits valid secret', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(gateway.baseUrl);
    await expect(page.locator('#login.fh-login-card .fh-login-logo')).toBeVisible();
    await expect(page.locator('#login.fh-login-card .fh-login-title')).toHaveText('fleetherd');

    await page.locator('#secret').fill('invalid-token');
    await page.locator('#login button[type="submit"]').click();
    await expect(page.locator('#err')).not.toBeEmpty();

    await page.locator('#secret').fill(gateway.secret);
    await page.locator('#login button[type="submit"]').click();
    await expect(page.locator('#workbench-root')).toBeVisible();
  });

  test('command palette switches from Ctrl+K to commands via > and opens Ctrl+/ shortcuts', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.keyboard.press('Control+k');
    await expect(page.locator('.fh-palette-topics')).toBeVisible();
    await expect(page.locator('.fh-palette-topics .fh-qp-foot')).toBeVisible();

    await page.locator('.fh-palette-topics .fh-qp-input').fill('>');
    await expect(page.locator('.fh-palette-commands')).toBeVisible();
    await expect(page.locator('.fh-palette-commands .fh-qp-kbd').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fh-palette-commands')).toHaveCount(0);

    await page.keyboard.press('Control+/');
    await expect(page.locator('.fh-palette-kb-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('mobile stack shell renders large title, bottom tabs, single detail header, and pill composer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('.wb-stack')).toBeVisible();
    await expect(page.locator('.wb-stack-large-title')).toBeVisible();
    await expect(page.locator('.wb-stack-tabbar .wb-stack-tab')).toHaveCount(4);

    await page.locator('.wb-stack-list-body .topic-item').first().click();
    await expect(page.locator('.wb-stack-detail-page')).toBeVisible();
    await expect(page.locator('.wb-stack-head .wb-stack-title')).toBeVisible();
    await expect(page.locator('.wb-stack-detail-body .wb-topic-header')).toBeHidden();
    await expect(page.locator('.wb-stack-detail-body #input')).toBeVisible();

    await page.screenshot({ path: '/tmp/wb2-mobile/shots/mobile-detail-dark.png' });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.screenshot({ path: '/tmp/wb2-mobile/shots/mobile-detail-light.png' });

    await page.locator('.wb-stack-back').click();
    await expect(page.locator('.wb-stack-list-page')).toBeVisible();
  });

  test('mobile More tab opens reviews, prefs, skills, settings, and appearance sub-pages with stack Back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const moreTab = page.locator('.wb-stack-tab[data-tab-id="more"]');
    await expect(moreTab).toBeVisible();
    await moreTab.click();

    const moreView = page.locator('.wb-stack-more');
    await expect(moreView).toBeVisible();
    await expect(moreView.locator('[data-group-item="reviews"]')).toBeVisible();
    await expect(moreView.locator('[data-group-item="review-prefs"]')).toBeVisible();
    await expect(moreView.locator('[data-group-item="skills"]')).toBeVisible();
    await expect(moreView.locator('[data-group-item="settings"]')).toBeVisible();
    await expect(moreView.locator('[data-group-item="appearance"]')).toBeVisible();

    await page.screenshot({ path: '/tmp/wb2-mobile/shots/mobile-more-dark.png' });

    // Open Appearance & Language sub-page and pop back
    await moreView.locator('[data-group-item="appearance"]').click();
    await expect(page.locator('.wb-stack-appearance')).toBeVisible();
    await page.screenshot({ path: '/tmp/wb2-mobile/shots/mobile-appearance-dark.png' });
    await page.locator('.wb-stack-back').click();
    await expect(moreView).toBeVisible();

    // Open Settings view from More and pop back
    await moreView.locator('[data-group-item="settings"]').click();
    await expect(page.locator('.wb-stack-detail-body .wb-set-catalog')).toBeVisible();
    await page.screenshot({ path: '/tmp/wb2-mobile/shots/mobile-settings-dark.png' });
    await page.locator('.wb-stack-back').click();
    await expect(moreView).toBeVisible();

    // Open Reviews and Skills views from More and pop back
    await moreView.locator('[data-group-item="reviews"]').click();
    await expect(page.locator('.wb-stack-detail-page')).toBeVisible();
    await page.locator('.wb-stack-back').click();
    await expect(moreView).toBeVisible();

    await moreView.locator('[data-group-item="skills"]').click();
    await expect(page.locator('.wb-stack-detail-page')).toBeVisible();
    await page.locator('.wb-stack-back').click();
    await expect(moreView).toBeVisible();
  });

  test('mobile long topic opens at the bottom and second open paints immediately from cache with ?last= resume', async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    const loginRes = await fetch(`${gateway.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: gateway.secret }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    const postJson = async (route: string, body: unknown) => {
      const r = await fetch(`${gateway.baseUrl}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
      return r.json();
    };
    const longId = ((await postJson('api/topics', { title: 'Long scroll topic' })) as { topic: { id: string } }).topic
      .id;
    const otherId = ((await postJson('api/topics', { title: 'Other mobile topic' })) as { topic: { id: string } }).topic
      .id;
    gateway.setMode('ok');
    for (let i = 1; i <= 4; i++) {
      await postJson('api/send', {
        topic: longId,
        text: `Turn ${i}\n${Array.from({ length: 14 }, (_, k) => `Line ${k + 2} of turn ${i}`).join('\n')}`,
        nonce: crypto.randomUUID(),
      });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const snap = (await (await fetch(`${gateway.baseUrl}/api/topic?t=${longId}`, { headers: { cookie } })).json()) as {
          messages?: Array<{ own?: boolean }>;
        };
        if ((snap.messages ?? []).filter((m) => !m.own).length >= i) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await postJson('api/send', { topic: otherId, text: 'Short topic', nonce: crypto.randomUUID() });

    await page.setViewportSize({ width: 390, height: 844 });
    const eventUrls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('api/events')) eventUrls.push(req.url().replace(gateway.baseUrl, ''));
    });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const longRow = page.locator(`.wb-stack-list-body .topic-item[data-topic="${longId}"]`);
    const otherRow = page.locator(`.wb-stack-list-body .topic-item[data-topic="${otherId}"]`);
    await expect(longRow).toBeVisible();

    // 1st open of long topic: must land at the bottom, not the first message.
    await longRow.click();
    await expect(page.locator('.wb-stack-detail-body #log .m').first()).toBeVisible();
    const firstScroll = await page.evaluate(() => {
      const log = document.querySelector<HTMLElement>('.wb-stack-detail-body #log')!;
      return {
        scrollHeight: log.scrollHeight,
        clientHeight: log.clientHeight,
        distFromBottom: log.scrollHeight - log.scrollTop - log.clientHeight,
      };
    });
    expect(firstScroll.scrollHeight).toBeGreaterThan(firstScroll.clientHeight + 500);
    expect(firstScroll.distFromBottom).toBeLessThan(80);

    // Switch away to other topic and back to list.
    await page.locator('.wb-stack-back').click();
    await expect(otherRow).toBeVisible();
    await otherRow.click();
    await expect(page.locator('.wb-stack-detail-body #log .m').first()).toBeVisible();
    await page.locator('.wb-stack-back').click();
    await expect(longRow).toBeVisible();

    // Throttle network (800ms RTT) and re-open long topic: must paint from cache immediately (< 500ms) and resume with ?last=.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 800,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (200 * 1024) / 8,
    });
    eventUrls.length = 0;
    const secondOpen = await page.evaluate((topicId) => {
      return new Promise<{ domMs: number; count: number; distFromBottom: number }>((resolve) => {
        const row = document.querySelector<HTMLElement>(`.wb-stack-list-body .topic-item[data-topic="${topicId}"]`)!;
        const t0 = performance.now();
        const check = () => {
          const log = document.querySelector<HTMLElement>('.wb-stack-detail-body #log');
          const count = log ? log.querySelectorAll('.m').length : 0;
          if (count > 0 && log && log.clientHeight > 0) {
            resolve({
              domMs: performance.now() - t0,
              count,
              distFromBottom: log.scrollHeight - log.scrollTop - log.clientHeight,
            });
            return;
          }
          requestAnimationFrame(check);
        };
        row.click();
        check();
      });
    }, longId);
    expect(secondOpen.count).toBeGreaterThanOrEqual(8);
    expect(secondOpen.domMs).toBeLessThan(500);
    expect(secondOpen.distFromBottom).toBeLessThan(80);
    expect(eventUrls.some((u) => u.includes(`t=${longId}`) && u.includes('last='))).toBe(true);
  });
});

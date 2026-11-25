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

  test('mobile (<640px) renders topic view as main screen with slide-out sidebar drawer, gestures, and back button', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const darkBg = await page.locator('#workbench-root').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkBg).toBe('rgb(31, 31, 31)');
    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'mobile');
    await expect(page.locator('.wb-shell')).toBeVisible();
    await expect(page.locator('.wb-stack')).toHaveCount(0);
    await expect(page.locator('.wb-topic-editor .wb-topic-header')).toBeVisible();
    await expect(page.locator('#expand-sidebar')).toBeVisible();
    await expect(page.locator('.wb-topic-editor #input')).toBeVisible();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-drawer-backdrop')).toBeHidden();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);


    // Hamburger button opens the slide-out sidebar drawer with full activity rail
    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-shell')).toHaveClass(/is-sidebar-open/);
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await expect(page.locator('.wb-activity-bar')).toBeVisible();
    await expect(page.locator('.wb-drawer-backdrop')).toBeVisible();

    for (const id of ['topics', 'history', 'schedules', 'reviews', 'skills', 'settings']) {
      await expect(page.locator(`.wb-activity-item[data-activity-id="${id}"]`)).toBeVisible();
    }
    const leakedMargin = await page.locator('.wb-sidebar .wb-topic-row').evaluateAll((rows) =>
      rows.some((r) => parseFloat(getComputedStyle(r).marginTop) > 0),
    );
    expect(leakedMargin).toBe(false);

    // Picking a topic switches to it and closes the drawer
    await page.locator('.wb-sidebar .topic-item').filter({ hasText: 'Slow cart API' }).first().click();
    await expect(page.locator('.wb-shell')).not.toHaveClass(/is-sidebar-open/);
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-topic-title')).toContainText('Slow cart API');

    // Swipe from left edge opens the drawer; tapping backdrop closes it
    await page.mouse.move(8, 320);
    await page.mouse.down();
    await page.mouse.move(220, 320, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.wb-shell')).toHaveClass(/is-sidebar-open/);
    await expect(page.locator('.wb-sidebar')).toBeVisible();

    // Swipe left on sidebar header closes the drawer
    const headBox = await page.locator('.wb-sidebar .wb-sidebar-head').boundingBox();
    expect(headBox).not.toBeNull();
    if (headBox) {
      const cy = headBox.y + headBox.height / 2;
      await page.mouse.move(headBox.x + headBox.width - 20, cy);
      await page.mouse.down();
      await page.mouse.move(headBox.x + 10, cy, { steps: 10 });
      await page.mouse.up();
    }
    await expect(page.locator('.wb-shell')).not.toHaveClass(/is-sidebar-open/);
    await expect(page.locator('.wb-sidebar')).toBeHidden();

    // Tapping outside (backdrop) closes the drawer
    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await page.mouse.click(375, 420);
    await expect(page.locator('.wb-sidebar')).toBeHidden();

    // Phone back gesture (browser back / popstate) closes the drawer first
    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-topic-editor')).toBeVisible();

    // Light theme topic screenshot
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightBg = await page.locator('#workbench-root').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(lightBg).toBe('rgb(255, 255, 255)');
  });

  test('mobile drawer switches across History, Schedules, Reviews, Skills, Settings, and reaches topic tools', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();

    for (const id of ['history', 'schedules', 'reviews', 'skills', 'settings']) {
      await page.locator(`.wb-activity-item[data-activity-id="${id}"]`).click();
      await expect(page.locator(`.wb-activity-item[data-activity-id="${id}"]`)).toHaveClass(/is-active/);
      await expect(page.locator('.wb-sidebar')).toBeVisible();
    }

    await expect(page.locator('.wb-sidebar .wb-set-catalog')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Device theme preference still works at 390x844 via Settings -> Device preferences
    const devItem = page.locator('.wb-sidebar .wb-set-catalog').getByRole('option', { name: 'Device preferences' });
    await expect(devItem).toBeVisible();
    await devItem.click();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    const lightBtn = page.locator('.fh-device-prefs .fh-seg-item').filter({ hasText: 'Light' }).first();
    await expect(lightBtn).toBeVisible();
    await lightBtn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('fh_theme'))).toBe('light');
    const darkBtn = page.locator('.fh-device-prefs .fh-seg-item').filter({ hasText: 'Dark' }).first();
    await darkBtn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('fh_theme'))).toBe('dark');
    await expect
      .poll(() => page.locator('#workbench-root').evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(31, 31, 31)');
    await page.locator('.wb-tab.is-active .wb-tab-close').click();

    // Close drawer via backdrop and open topic tool (Changes) from topic header
    await expect(page.locator('.wb-sidebar')).toBeHidden();

    const changesBtn = page.locator('.wb-topic-tools [data-tool-id="changes"]');
    await expect(changesBtn).toBeVisible();
    await changesBtn.click();
    await expect(page.locator('.wb-secondary')).toBeVisible();
    await expect(page.locator('.wb-shell')).toHaveClass(/is-secondary-open/);
    await page.locator('.wb-secondary .wb-part-close').click();
    await expect(page.locator('.wb-secondary')).toBeHidden();
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

    const longRow = page.locator(`.wb-sidebar .topic-item[data-topic="${longId}"]`);
    const otherRow = page.locator(`.wb-sidebar .topic-item[data-topic="${otherId}"]`);
    await page.locator('#expand-sidebar').click();
    await expect(longRow).toBeVisible();

    // 1st open of long topic: must land at the bottom, not the first message.
    await longRow.click();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-topic-editor #log .m').first()).toBeVisible();
    const firstScroll = await page.evaluate(() => {
      const log = document.querySelector<HTMLElement>('.wb-topic-editor #log')!;
      return {
        scrollHeight: log.scrollHeight,
        clientHeight: log.clientHeight,
        distFromBottom: log.scrollHeight - log.scrollTop - log.clientHeight,
      };
    });
    expect(firstScroll.scrollHeight).toBeGreaterThan(firstScroll.clientHeight + 500);
    expect(firstScroll.distFromBottom).toBeLessThan(80);

    // Switch away to other topic and reopen the drawer.
    await page.locator('#expand-sidebar').click();
    await expect(otherRow).toBeVisible();
    await otherRow.click();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-topic-editor #log .m').first()).toBeVisible();
    await page.locator('#expand-sidebar').click();
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
        const row = document.querySelector<HTMLElement>(`.wb-sidebar .topic-item[data-topic="${topicId}"]`)!;
        const t0 = performance.now();
        const check = () => {
          const log = document.querySelector<HTMLElement>('.wb-topic-editor #log');
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

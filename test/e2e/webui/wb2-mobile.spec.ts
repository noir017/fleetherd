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
});

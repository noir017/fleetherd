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

    await page.screenshot({ path: '/tmp/wb4-mobile/after-topic-dark.png' });

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
    await page.screenshot({ path: '/tmp/wb4-mobile/after-drawer-topics-dark.png' });

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
    await page.screenshot({ path: '/tmp/wb4-mobile/after-topic-light.png' });
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
    await page.screenshot({ path: '/tmp/wb4-mobile/after-drawer-settings-dark.png' });

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
});

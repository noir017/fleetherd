import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;
let seededIds: Record<string, string> = {};

const TOPIC_ONE = 'Workbench primary topic';
const TOPIC_TWO = 'Workbench secondary topic';

test.describe('Web UI workbench cutover suite', () => {
  test.beforeAll(async () => {
    gateway = await startGateway();
    const seeded = await seedTopics(gateway, [
      { title: TOPIC_ONE, message: 'workbench payload one' },
      { title: TOPIC_TWO, message: 'workbench payload two', starred: true },
    ]);
    seededIds = seeded.topics;
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('mounts default three-part workbench with VS Code Dark Modern & Light Modern palettes', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const root = page.locator('#workbench-root');
    await expect(root).toHaveAttribute('data-wb-mode', 'desktop');
    await expect(page.locator('.wb-activity-bar')).toBeVisible();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await expect(page.locator('.wb-editor-area')).toBeVisible();
    await expect(page.locator('.wb-status-bar')).toBeVisible();

    const darkColors = await page.evaluate(() => {
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const sideBg = getComputedStyle(document.querySelector('.wb-sidebar')!).backgroundColor;
      return { bodyBg, sideBg, theme: document.documentElement.dataset.theme };
    });
    expect(darkColors.theme).toBe('dark');
    expect(darkColors.bodyBg).toBe('rgb(31, 31, 31)');
    expect(darkColors.sideBg).toBe('rgb(24, 24, 24)');

    // Cycle System -> Dark -> Light via status bar theme button.
    const themeBtn = page.locator('[data-status-id="status.theme"]');
    await expect(themeBtn).toBeVisible();
    await themeBtn.click(); // Dark
    await themeBtn.click(); // Light

    const lightColors = await page.evaluate(() => {
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const sideBg = getComputedStyle(document.querySelector('.wb-sidebar')!).backgroundColor;
      return { bodyBg, sideBg, theme: document.documentElement.dataset.theme };
    });
    expect(lightColors.theme).toBe('light');
    expect(lightColors.bodyBg).toBe('rgb(255, 255, 255)');
    expect(lightColors.sideBg).toBe('rgb(248, 248, 248)');
  });

  test('responds to desktop (1280), tablet (800), and mobile (390) width breakpoints', async ({ page }) => {
    await loginViaUi(page, gateway.baseUrl, gateway.secret);
    const root = page.locator('#workbench-root');

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(root).toHaveAttribute('data-wb-mode', 'desktop');
    await expect(page.locator('.wb-shell')).toBeVisible();

    await page.setViewportSize({ width: 800, height: 900 });
    await expect(root).toHaveAttribute('data-wb-mode', 'tablet');
    await expect(page.locator('.wb-drawer-backdrop')).toBeHidden();
    await page.locator('.wb-activity-item[data-activity-id="topics"]').click();
    await expect(page.locator('.wb-drawer-backdrop')).toBeVisible();
    await page.locator('.wb-drawer-backdrop').click();
    await expect(page.locator('.wb-drawer-backdrop')).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(root).toHaveAttribute('data-wb-mode', 'mobile');
    await expect(page.locator('.wb-shell')).toBeVisible();
    await expect(page.locator('#expand-sidebar')).toBeVisible();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await expect(page.locator('.wb-drawer-backdrop')).toBeVisible();
    await page.mouse.click(375, 420);
    await expect(page.locator('.wb-sidebar')).toBeHidden();
  });

  test('switches sidebar views via activity bar and interacts with status bar controls', async ({
    page,
  }) => {
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    for (const id of ['history', 'schedules', 'reviews', 'skills', 'settings', 'topics']) {
      const btn = page.locator(`.wb-activity-item[data-activity-id="${id}"]`);
      await expect(btn).toBeVisible();
      await btn.click();
      await expect(btn).toHaveClass(/\bis-active\b/);
    }

    // Topic selection still works after switching views.
    const secondId = seededIds[TOPIC_TWO];
    expect(secondId).toBeTruthy();
    await page.locator(`#topics .topic-item[data-topic="${secondId}"]`).click();
    await expect(page.locator('#topic-title')).toContainText(TOPIC_TWO);

    // Status bar connection, calm mode, and language toggle.
    await expect(page.locator('[data-status-id="status.connection"]')).toHaveAttribute('data-state', 'connected');
    await page.locator('[data-status-id="status.calm"]').click();
    await expect(page.locator('#workbench-root')).toHaveClass(/\bcalm\b/);

    await page.locator('[data-status-id="status.locale"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.locator('[data-status-id="status.locale"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

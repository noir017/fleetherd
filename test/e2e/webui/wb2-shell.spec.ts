import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;

test.describe('Web UI wb2-shell desktop and tablet alignment', () => {
  test.beforeAll(async () => {
    gateway = await startGateway({ title: 'fleetherd' });
    await seedTopics(gateway, [
      { title: 'Refactor webui panels', message: 'Check shell alignment' },
      { title: 'Deploy notes for 3.38', message: 'Draft release checklist', starred: true },
    ]);
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('desktop shell dimensions, permanent 38px tab bar, sidebar decoupling, and status bar items', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'desktop');
    await expect(page.locator('.wb-activity-item[data-activity-id="topics"]')).toHaveClass(/\bis-active\b/);

    const metrics = await page.evaluate(() => ({
      railW: Math.round(document.querySelector('.wb-activity-bar')!.getBoundingClientRect().width),
      sidebarHeadH: Math.round(document.querySelector('.wb-sidebar-head')!.getBoundingClientRect().height),
      tabBarH: Math.round(document.querySelector('.wb-group-head.wb-tab-bar')!.getBoundingClientRect().height),
      topicHeadH: Math.round(document.querySelector('.wb-topic-header')!.getBoundingClientRect().height),
      statusBarH: Math.round(document.querySelector('.wb-status-bar')!.getBoundingClientRect().height),
    }));
    expect(metrics).toEqual({
      railW: 52,
      sidebarHeadH: 48,
      tabBarH: 38,
      topicHeadH: 48,
      statusBarH: 26,
    });

    // Status bar brand, connection check icon, and idle dialog flow.
    await expect(page.locator('[data-status-id="status.brand"]')).toHaveClass(/\bis-prominent\b/);
    await expect(page.locator('[data-status-id="status.connection"] .ic-check')).toBeVisible();
    await page.locator('[data-status-id="status.idle"]').click();
    await expect(page.locator('.fh-idle-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fh-idle-dialog')).toBeHidden();

    // Switching sidebar to History keeps topic tab open without redundant sidebar tabs.
    await page.locator('.wb-activity-item[data-activity-id="history"]').click();
    await expect(page.locator('.wb-activity-item[data-activity-id="history"]')).toHaveClass(/\bis-active\b/);
    await expect(page.locator('.wb-sidebar .wb-part-tabs')).toBeHidden();
    await expect(page.locator('.wb-editor-group .wb-tab')).toHaveCount(1);

    // Desktop 1200px auto-collapses primary sidebar when opening secondary pane, and restores on close.
    await page.locator('.wb-activity-item[data-activity-id="topics"]').click();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.locator('[data-tool-id="changes"]').click();
    await expect(page.locator('.wb-secondary')).toBeVisible();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await page.locator('.wb-secondary .wb-part-close').click();
    await expect(page.locator('.wb-secondary')).toBeHidden();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
  });

  test('tablet 820px collapsed, list drawer, secondary pane drawer, and Escape dismiss', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1100 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'tablet');
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-drawer-backdrop')).toBeHidden();

    // Open list drawer (300px)
    await page.locator('.wb-activity-item[data-activity-id="topics"]').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await expect(page.locator('.wb-drawer-backdrop')).toBeVisible();
    const listW = await page.evaluate(() => Math.round(document.querySelector('.wb-sidebar')!.getBoundingClientRect().width));
    expect(listW).toBe(300);

    // Escape closes list drawer
    await page.keyboard.press('Escape');
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-drawer-backdrop')).toBeHidden();

    // Open secondary pane drawer (520px)
    await page.locator('[data-tool-id="changes"]').click();
    await expect(page.locator('.wb-secondary')).toBeVisible();
    await expect(page.locator('.wb-drawer-backdrop')).toBeVisible();
    const paneW = await page.evaluate(() => Math.round(document.querySelector('.wb-secondary')!.getBoundingClientRect().width));
    expect(paneW).toBe(520);
  });
});

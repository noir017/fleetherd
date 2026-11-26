import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;

const TOPIC_ONE = 'Dock primary topic';
const TOPIC_TWO = 'Dock secondary topic';

async function openSecondEditorTab(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.wb-activity-item[data-activity-id="settings"]').click();
  const tabs = page.locator('.wb-editor-group .wb-tab');
  if ((await tabs.count()) < 2) {
    const row = page.locator('.wb-sidebar .fh-list-row').first();
    await expect(row).toBeVisible();
    await row.click();
  }
  await expect(tabs.nth(1)).toBeVisible();
}

async function pointerDrag(
  page: import('@playwright/test').Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.describe('Web UI dynamic dock engine E2E', () => {
  test.beforeAll(async () => {
    gateway = await startGateway();
    await seedTopics(gateway, [
      { title: TOPIC_ONE, message: 'dock payload one' },
      { title: TOPIC_TWO, message: 'dock payload two' },
    ]);
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('reorders tabs via pointer drag, splits editor groups via drag and shortcut, and restores aa_layout on reload', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await openSecondEditorTab(page);

    const tabs = page.locator('.wb-editor-group .wb-tab');
    const firstIdBefore = await tabs.nth(0).getAttribute('data-panel-id');
    const secondIdBefore = await tabs.nth(1).getAttribute('data-panel-id');
    expect(firstIdBefore).toBeTruthy();
    expect(secondIdBefore).toBeTruthy();

    // Pointer-drag second tab before the first tab to reorder.
    const box0 = (await tabs.nth(0).boundingBox())!;
    const box1 = (await tabs.nth(1).boundingBox())!;
    await pointerDrag(
      page,
      { x: box1.x + box1.width / 2, y: box1.y + box1.height / 2 },
      { x: box0.x + 4, y: box0.y + box0.height / 2 },
    );
    await expect(tabs.nth(0)).toHaveAttribute('data-panel-id', secondIdBefore!);
    await expect(tabs.nth(1)).toHaveAttribute('data-panel-id', firstIdBefore!);

    // Split active editor to the right via pointer drag onto the right edge of the editor group.
    const groupBox = (await page.locator('.wb-editor-group').first().boundingBox())!;
    const activeTabBox = (await tabs.nth(0).boundingBox())!;
    await pointerDrag(
      page,
      { x: activeTabBox.x + activeTabBox.width / 2, y: activeTabBox.y + activeTabBox.height / 2 },
      { x: groupBox.x + groupBox.width - 20, y: groupBox.y + groupBox.height / 2 },
    );
    await expect(page.locator('.wb-editor-group')).toHaveCount(2);

    // Verify aa_layout is persisted in localStorage.
    const savedRaw = await page.evaluate(() => localStorage.getItem('aa_layout'));
    expect(savedRaw).toBeTruthy();
    const saved = JSON.parse(savedRaw!) as { v: number; grid: { type: string } };
    expect(saved.v).toBe(1);
    expect(saved.grid.type).toBe('branch');

    // Reload page and confirm split editor layout is restored.
    await page.reload();
    await expect(page.locator('#workbench-root')).toBeVisible();
    await expect(page.locator('.wb-editor-group')).toHaveCount(2);
  });

  test('moves views across sidebar, secondary sidebar, and bottom panel via header menu and persists across reload', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const moreBtn = page.locator('.wb-sidebar .wb-part-more');
    await expect(moreBtn).toBeVisible();
    await moreBtn.click();

    const moveMenu = page.locator('.wb-view-move-menu');
    await expect(moveMenu).toBeVisible();
    await moveMenu.locator('[data-menu-id="workbench.action.moveViewToPanel"]').click();

    // Topics view moved into bottom panel and panel became visible.
    await expect(page.locator('.wb-panel')).toBeVisible();
    await expect(page.locator('.wb-panel .wb-part-tab[data-panel-id="topics"]')).toBeVisible();

    // Reload and confirm the moved view remains in the bottom panel.
    await page.reload();
    await expect(page.locator('#workbench-root')).toBeVisible();
    await expect(page.locator('.wb-panel')).toBeVisible();
    await expect(page.locator('.wb-panel .wb-part-tab[data-panel-id="topics"]')).toBeVisible();

    // Move it back to primary sidebar via bottom panel header menu.
    await page.locator('.wb-panel .wb-part-more').click();
    await page.locator('.wb-view-move-menu [data-menu-id="workbench.action.moveViewToSidebar"]').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
  });

  test('disables splitting in tablet mode (800px) while keeping tab reordering', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await openSecondEditorTab(page);

    // Switch to tablet width (800px) and dismiss the sidebar drawer backdrop.
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'tablet');
    const backdrop = page.locator('.wb-drawer-backdrop');
    if (await backdrop.isVisible()) {
      await backdrop.click();
    }

    // Attempt to split via Ctrl+\ shortcut -> blocked with notice, still 1 editor group.
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('.wb-editor-group')).toHaveCount(1);
    await expect(page.locator('.wb-toast')).toBeVisible();

    // Attempt to split via pointer drag to right edge -> still 1 editor group.
    const tabs = page.locator('.wb-editor-group .wb-tab');
    const groupBox = (await page.locator('.wb-editor-group').first().boundingBox())!;
    const tab0Box = (await tabs.nth(0).boundingBox())!;
    await pointerDrag(
      page,
      { x: tab0Box.x + tab0Box.width / 2, y: tab0Box.y + tab0Box.height / 2 },
      { x: groupBox.x + groupBox.width - 16, y: groupBox.y + groupBox.height / 2 },
    );
    await expect(page.locator('.wb-editor-group')).toHaveCount(1);

    // Tab reordering still works in tablet mode.
    const firstId = await tabs.nth(0).getAttribute('data-panel-id');
    const secondId = await tabs.nth(1).getAttribute('data-panel-id');
    const box0 = (await tabs.nth(0).boundingBox())!;
    const box1 = (await tabs.nth(1).boundingBox())!;
    await pointerDrag(
      page,
      { x: box1.x + box1.width / 2, y: box1.y + box1.height / 2 },
      { x: box0.x + 4, y: box0.y + box0.height / 2 },
    );
    await expect(tabs.nth(0)).toHaveAttribute('data-panel-id', secondId!);
    await expect(tabs.nth(1)).toHaveAttribute('data-panel-id', firstId!);
  });

  test('a click on an older tab shows it, and the sidebar reopens at the width it was closed at', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);
    await openSecondEditorTab(page);

    const tabs = page.locator('.wb-editor-group .wb-tab');
    for (const i of [0, 1, 0]) {
      await tabs.nth(i).click();
      await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(1 - i)).toHaveAttribute('aria-selected', 'false');
    }

    const sidebar = page.locator('.wb-sidebar');
    const widthOf = async (): Promise<number> => Math.round((await sidebar.boundingBox())!.width);
    const before = await widthOf();
    const sash = await page.evaluate(() => {
      const edge = document.querySelector('.wb-sidebar')!.getBoundingClientRect().right;
      const boxes = Array.from(document.querySelectorAll('.wb-sash')).map((s) => s.getBoundingClientRect());
      const near = boxes.filter((b) => b.height > 0).sort((a, b) => Math.abs(a.x - edge) - Math.abs(b.x - edge))[0]!;
      return { x: near.x + near.width / 2, y: near.y + near.height / 2 };
    });
    await pointerDrag(page, sash, { x: sash.x + 120, y: sash.y });
    const dragged = await widthOf();
    expect(dragged).toBeGreaterThan(before + 60);

    const active = page.locator('.wb-activity-item.is-active');
    await active.click();
    await expect(sidebar).toBeHidden();
    await active.click();
    await expect(sidebar).toBeVisible();
    expect(Math.abs((await widthOf()) - dragged)).toBeLessThanOrEqual(2);
  });
});

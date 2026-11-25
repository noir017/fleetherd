import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;
let seededIds: Record<string, string> = {};

const TOPIC_REVIEW = 'Review PR #42';
const TOPIC_STARRED = 'Deploy notes for 3.38';
const TOPIC_FAILED = 'Flaky CI on arm64';

test.describe('Workbench topics list, row menu, confirm dialog, and mobile gestures', () => {
  test.beforeAll(async () => {
    gateway = await startGateway({ title: 'fleetherd-wb2-e2e' });
    const seeded = await seedTopics(gateway, [
      { title: TOPIC_REVIEW, message: 'review' },
      { title: TOPIC_STARRED, message: 'deploy', starred: true },
      { title: TOPIC_FAILED, message: 'fail', mode: 'prompt-error' },
    ]);
    seededIds = seeded.topics;
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('desktop renders grouped topics, 3-section row menu, and delete confirmation flow', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const groups = page.locator('.wb-sidebar .wb-topics-grp');
    await expect(groups.first()).toBeVisible();

    const starredId = seededIds[TOPIC_STARRED]!;
    const row = page.locator(`.wb-sidebar .wb-topic-row[data-topic="${starredId}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('.topic-hc')).toBeVisible();

    // Open row menu and check items + 2 separators
    await row.hover();
    await row.locator('[data-rm]').click({ force: true });
    const menu = page.locator('.wb-topic-row-menu:not([hidden])');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.fh-menu-sep')).toHaveCount(2);
    await expect(menu.locator('[data-menu-id="topics.unstar"]')).toBeVisible();
    await expect(menu.locator('[data-menu-id="topics.copyRef"]')).toBeVisible();
    await expect(menu.locator('[data-menu-id="topics.openInNewTab"]')).toBeVisible();
    await expect(menu.locator('[data-menu-id="topics.endAgent"]')).toBeVisible();
    await expect(menu.locator('[data-menu-id="topics.delete"]')).toBeVisible();

    // Delete opens confirmation dialog; Cancel preserves row
    await menu.locator('[data-menu-id="topics.delete"]').click();
    const dlg = page.locator('.fh-dialog-backdrop .fh-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.fh-dialog-title')).toContainText(TOPIC_STARRED);
    await dlg.locator('[data-dialog-action="cancel"]').click();
    await expect(dlg).toBeHidden();
    await expect(row).toBeVisible();
  });

  test('mobile supports large title, left-swipe actions, bottom sheet, and delete alert', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('.wb-stack .wb-stack-large-title')).toBeVisible();
    await expect(page.locator('.wb-stack .wb-topics-mobile-title')).toBeHidden();

    const reviewId = seededIds[TOPIC_REVIEW]!;
    const row = page.locator(`.wb-stack .wb-topic-row[data-topic="${reviewId}"]`);
    await expect(row).toBeVisible();

    // Left-swipe reveals Star / More / Delete
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      const cy = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width - 24, cy);
      await page.mouse.down();
      await page.mouse.move(box.x + 40, cy, { steps: 10 });
      await page.mouse.up();
    }
    const wrap = page.locator(`.wb-stack .wb-topic-swipe-wrap[data-swipe-wrap="${reviewId}"]`);
    await expect(wrap).toHaveClass(/is-swiped/);

    // Tap More to open bottom action sheet
    await wrap.locator('[data-swipe-act="more"]').click();
    const sheet = page.locator('.wb-topic-sheet-backdrop .fh-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.fh-sheet-title')).toContainText(TOPIC_REVIEW);
    await expect(sheet.locator('[data-sheet-action="topics.openInNewTab"]')).toHaveCount(0);

    // Tap Delete in bottom sheet -> confirm alert -> Cancel
    await sheet.locator('[data-sheet-action="topics.delete"]').click();
    const dlg = page.locator('.fh-dialog-backdrop .fh-dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-dialog-action="cancel"]').click();
    await expect(dlg).toBeHidden();
  });
});

import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;
let seededIds: Record<string, string> = {};

const TOPIC_A = 'Split topic alpha';
const TOPIC_B = 'Split topic beta';
const TOPIC_C = 'Split topic gamma';

test.describe('Web UI split live topic editors E2E', () => {
  test.beforeAll(async () => {
    gateway = await startGateway();
    const seeded = await seedTopics(gateway, [
      { title: TOPIC_A, message: 'seed alpha message' },
      { title: TOPIC_B, message: 'seed beta message' },
      { title: TOPIC_C, message: 'seed gamma message' },
    ]);
    seededIds = seeded.topics;
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('opens a second topic in a new tab, splits right, receives live replies in both, and restores after reload', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const idA = seededIds[TOPIC_A]!;
    const idB = seededIds[TOPIC_B]!;
    const idC = seededIds[TOPIC_C]!;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idC).toBeTruthy();

    await page.goto(`${gateway.baseUrl}/?t=${idA}`);
    const edA = page.locator(`.wb-topic-editor[data-topic-id="${idA}"]`);
    await expect(edA.locator('.log')).toContainText('seed alpha message', { timeout: 10_000 });

    // Open topic B in a new pinned tab via the sidebar context menu.
    const rowB = page.locator(`.wb-sidebar [data-topic="${idB}"]`);
    await expect(rowB).toBeVisible();
    await rowB.click({ button: 'right' });
    const openInNewTab = page.locator('[data-menu-id="topics.openInNewTab"]');
    await expect(openInNewTab).toBeVisible();
    await openInNewTab.click();

    // Split the active pinned tab to the right so both topic editors are visible side by side.
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('.wb-editor-group')).toHaveCount(2);

    const edB = page.locator(`.wb-topic-editor[data-topic-id="${idB}"]`);
    await expect(edA).toBeVisible();
    await expect(edB).toBeVisible();
    await expect(edB.locator('.log')).toContainText('seed beta message', { timeout: 10_000 });

    // Send independently from both composers and confirm both receive live replies without switching focus.
    const msgA = 'live ping for alpha';
    const msgB = 'live ping for beta';
    await edA.locator('textarea.composer-input, textarea').first().fill(msgA);
    await edA.locator('.wb-topic-send').click();
    await edB.locator('textarea.composer-input, textarea').first().fill(msgB);
    await edB.locator('.wb-topic-send').click();

    await expect(edA.locator('.log')).toContainText(`echo(alpha): ${msgA}`, { timeout: 15_000 });
    await expect(edB.locator('.log')).toContainText(`echo(alpha): ${msgB}`, { timeout: 15_000 });
    await expect(edA.locator('.log')).not.toContainText(msgB);
    await expect(edB.locator('.log')).not.toContainText(msgA);

    // Clicking a third topic in the sidebar navigates topic:active (A -> C) while pinned B stays open and live.
    const rowC = page.locator(`.wb-sidebar [data-topic="${idC}"]`);
    await rowC.click();
    const edC = page.locator(`.wb-topic-editor[data-topic-id="${idC}"]`);
    await expect(edC.locator('.log')).toContainText('seed gamma message', { timeout: 10_000 });
    await expect(edB).toBeVisible();

    const followUpB = 'pinned beta still live';
    await edB.locator('textarea.composer-input, textarea').first().fill(followUpB);
    await edB.locator('.wb-topic-send').click();
    await expect(edB.locator('.log')).toContainText(`echo(alpha): ${followUpB}`, { timeout: 15_000 });

    // Reload and confirm the split layout and pinned topic editor restore and remain live.
    await page.reload();
    await expect(page.locator('#workbench-root')).toBeVisible();
    await expect(page.locator('.wb-editor-group')).toHaveCount(2);
    await expect(page.locator(`.wb-topic-editor[data-topic-id="${idC}"] .log`)).toContainText('seed gamma message', {
      timeout: 10_000,
    });
    await expect(page.locator(`.wb-topic-editor[data-topic-id="${idB}"] .log`)).toContainText(followUpB, {
      timeout: 10_000,
    });
  });
});

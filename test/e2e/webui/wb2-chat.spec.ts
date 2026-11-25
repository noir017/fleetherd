import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;
let seededIds: Record<string, string> = {};

const RICH_TOPIC = 'Refactor webui panels';
const NEW_TOPIC = 'New topic';

test.describe('wb2-chat topic editor alignment', () => {
  test.beforeAll(async () => {
    gateway = await startGateway();
    const seeded = await seedTopics(gateway, [
      {
        title: RICH_TOPIC,
        message: 'Check header, tool card, status row, and composer alignment',
        mode: 'rich',
        starred: true,
      },
      { title: NEW_TOPIC },
    ]);
    seededIds = seeded.topics;
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('desktop #topic and #new align header tools, status row, composer, and model popover', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const richId = seededIds[RICH_TOPIC];
    expect(richId).toBeTruthy();
    await page.goto(`${gateway.baseUrl}/?t=${richId}`);
    await expect(page.locator('.wb-topic-editor .m').first()).toBeVisible();
    await expect(page.locator('.wb-topic-editor .wb-topic-tools')).toBeVisible();
    await expect(page.locator('.wb-topic-editor .tl').first()).toBeVisible();
    await expect(page.locator('.wb-topic-editor .wb-topic-status-row')).toBeVisible();
    await expect(page.locator('.wb-topic-editor .wb-topic-dir')).toBeVisible();

    const modelBtn = page.locator('.wb-topic-editor #status .st-model').first();
    await expect(modelBtn).toBeVisible();
    await modelBtn.click();
    await expect(page.locator('.wb-topic-editor #model-pop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.wb-topic-editor #model-pop')).toBeHidden();

    const newId = seededIds[NEW_TOPIC];
    expect(newId).toBeTruthy();
    await page.goto(`${gateway.baseUrl}/?t=${newId}`);
    await expect(page.locator('.wb-topic-editor .launch .agent-card.def')).toBeVisible();
  });

  test('mobile ?m#topic hides duplicate header and renders pill composer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const topicRow = page.locator('.wb-stack-list-body .topic-item').filter({ hasText: RICH_TOPIC }).first();
    await expect(topicRow).toBeVisible();
    await topicRow.click();

    const detailEditor = page.locator('.wb-stack-detail-body .wb-topic-editor');
    await expect(detailEditor).toBeVisible();
    await expect(detailEditor.locator('> .wb-topic-header')).toBeHidden();
    await expect(detailEditor.locator('.wb-topic-attach')).toBeVisible();
    await expect(detailEditor.locator('.wb-topic-send')).toBeVisible();
  });
});

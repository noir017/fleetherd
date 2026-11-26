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

  test('mobile topic hides duplicate tab bar and renders pill composer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator('#expand-sidebar').click();
    const topicRow = page.locator('.wb-sidebar .topic-item').filter({ hasText: RICH_TOPIC }).first();
    await expect(topicRow).toBeVisible();
    await topicRow.click();
    await expect(page.locator('.wb-sidebar')).toBeHidden();

    const editor = page.locator('.wb-topic-editor');
    await expect(editor).toBeVisible();
    await expect(page.locator('.wb-group-head')).toBeHidden();
    await expect(editor.locator('> .wb-topic-header')).toBeVisible();
    await expect(editor.locator('.wb-topic-attach')).toBeVisible();
    await expect(editor.locator('.wb-topic-send')).toBeVisible();
  });

  test('send-now with interrupt keeps the sent message visible in transcript live and after reload', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const richId = seededIds[RICH_TOPIC];
    expect(richId).toBeTruthy();
    await page.goto(`${gateway.baseUrl}/?t=${richId}`);
    await expect(page.locator('.wb-topic-editor .m').first()).toBeVisible();

    const input = page.locator('.wb-topic-editor #input');
    const sendBtn = page.locator('.wb-topic-editor .wb-topic-send');
    const pendingQueue = page.locator('.wb-topic-editor #pending-queue');

    try {
      // Hold the first turn open so the second message queues as a pending card.
      gateway.setMode('slow');
      await input.fill('hold this turn open');
      await sendBtn.click();
      await expect(page.locator('.wb-topic-editor #stop-turn')).toBeVisible({ timeout: 10_000 });

      const followUp = 'urgent send-now message';
      await input.fill(followUp);
      await sendBtn.click();

      await expect(pendingQueue).toBeVisible({ timeout: 10_000 });
      await expect(pendingQueue).toContainText(followUp);

      // Let the interrupted follow-up turn complete normally once delivered.
      gateway.setMode('ok');
      await pendingQueue.locator('[data-pq-send]').click();
      await pendingQueue.locator('[data-pq-confirm]').click();

      // The agent replies to the sent-now message, and the user's own message must appear in #log.
      await expect(page.locator('.wb-topic-editor #log')).toContainText(`echo(alpha): ${followUp}`, { timeout: 15_000 });
      await expect(page.locator('.wb-topic-editor #log .m.own').filter({ hasText: followUp })).toBeVisible();
      await expect(pendingQueue).toBeHidden();

      // Reload and confirm the message persists in the transcript.
      await page.reload();
      await expect(page.locator('.wb-topic-editor #log .m.own').filter({ hasText: followUp })).toBeVisible({ timeout: 10_000 });
    } finally {
      gateway.setMode('ok');
    }
  });
});

import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;
let seededIds: Record<string, string> = {};

const TOPIC_ALPHA = 'Alpha smoke topic';
const TOPIC_BETA = 'Beta smoke topic';
const ALPHA_MSG = 'alpha unique payload 101';
const BETA_MSG = 'beta unique payload 202';

test.describe('Web UI smoke suite', () => {
  test.beforeAll(async () => {
    gateway = await startGateway();
    const seeded = await seedTopics(gateway, [
      { title: TOPIC_ALPHA, message: ALPHA_MSG },
      { title: TOPIC_BETA, message: BETA_MSG, starred: true },
    ]);
    seededIds = seeded.topics;
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('login gate rejects wrong secret and admits valid secret', async ({ page }) => {
    await page.goto(gateway.baseUrl);
    await expect(page.locator('#gate')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();

    await page.locator('#secret').fill('wrong-secret-value');
    await page.locator('#gate button[type="submit"]').click();

    await expect(page.locator('#err')).not.toBeEmpty();
    await expect(page.locator('#gate')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();

    await page.locator('#secret').fill(gateway.secret);
    await page.locator('#gate button[type="submit"]').click();

    await expect(page.locator('#gate')).toBeHidden();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#topics')).toBeVisible();
    await expect(page.locator('#input')).toBeVisible();
  });

  test('sending a message streams fake ACP agent reply into transcript', async ({ page }) => {
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator('#new-topic').click();
    const promptText = `hello e2e stream ${Date.now()}`;
    await page.locator('#input').fill(promptText);
    await page.locator('#composer button[type="submit"]').click();

    const log = page.locator('#log');
    await expect(log).toContainText(promptText);
    await expect(log).toContainText(`echo(alpha): ${promptText}`);
  });

  test('switching and creating topics updates title, selection, and transcript without bleed', async ({
    page,
  }) => {
    const alphaId = seededIds[TOPIC_ALPHA];
    const betaId = seededIds[TOPIC_BETA];
    expect(alphaId).toBeTruthy();
    expect(betaId).toBeTruthy();

    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const alphaRow = page.locator(`#topics .topic-item[data-topic="${alphaId}"]`);
    const betaRow = page.locator(`#topics .topic-item[data-topic="${betaId}"]`);
    await expect(alphaRow).toBeVisible();
    await expect(betaRow).toBeVisible();

    await alphaRow.click();
    await expect(alphaRow).toHaveClass(/\bon\b/);
    await expect(betaRow).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#topic-title')).toContainText(TOPIC_ALPHA);
    await expect(page.locator('#log')).toContainText(`echo(alpha): ${ALPHA_MSG}`);
    await expect(page.locator('#log')).not.toContainText(BETA_MSG);

    await betaRow.click();
    await expect(betaRow).toHaveClass(/\bon\b/);
    await expect(alphaRow).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#topic-title')).toContainText(TOPIC_BETA);
    await expect(page.locator('#log')).toContainText(`echo(alpha): ${BETA_MSG}`);
    await expect(page.locator('#log')).not.toContainText(ALPHA_MSG);

    await page.locator('#new-topic').click();
    await expect(alphaRow).not.toHaveClass(/\bon\b/);
    await expect(betaRow).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#topics .topic-item.on')).toHaveCount(1);
    await expect(page.locator('#log')).not.toContainText(ALPHA_MSG);
    await expect(page.locator('#log')).not.toContainText(BETA_MSG);
  });

  test('mobile viewport (390x844) has no horizontal overflow and toggles sidebar drawer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const sidebar = page.locator('#sidebar');
    const expandBtn = page.locator('#expand-sidebar');
    const collapseBtn = page.locator('#collapse-sidebar');
    const input = page.locator('#input');
    const sendBtn = page.locator('#composer button[type="submit"]');

    await expect(expandBtn).toBeVisible();
    await expect(sidebar).toHaveClass(/\bcollapsed\b/);
    await expect(input).toBeVisible();
    await expect(sendBtn).toBeVisible();

    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(hasOverflow).toBe(false);

    await expandBtn.click();
    await expect(sidebar).not.toHaveClass(/\bcollapsed\b/);
    await expect(page.locator(`#topics .topic-item[data-topic="${seededIds[TOPIC_ALPHA]}"]`)).toBeVisible();

    await collapseBtn.click();
    await expect(sidebar).toHaveClass(/\bcollapsed\b/);
    await expect(expandBtn).toBeVisible();

    await input.click();
    await expect(input).toBeFocused();
  });
});

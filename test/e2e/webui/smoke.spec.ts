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
    await expect(page.locator('#workbench-root')).toBeHidden();

    await page.locator('#secret').fill('wrong-secret-value');
    await page.locator('#gate button[type="submit"]').click();

    await expect(page.locator('#err')).not.toBeEmpty();
    await expect(page.locator('#gate')).toBeVisible();
    await expect(page.locator('#workbench-root')).toBeHidden();

    await page.locator('#secret').fill(gateway.secret);
    await page.locator('#gate button[type="submit"]').click();

    await expect(page.locator('#gate')).toBeHidden();
    await expect(page.locator('#workbench-root')).toBeVisible();
    await expect(page.locator('.wb-activity-bar')).toBeVisible();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await expect(page.locator('#topics')).toBeVisible();
    await expect(page.locator('#input')).toBeVisible();
  });

  test('sending a message streams fake ACP agent reply into transcript', async ({ page }) => {
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator('[data-action-id="topics.new"]').click();
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

    await page.locator('[data-action-id="topics.new"]').click();
    await expect(alphaRow).not.toHaveClass(/\bon\b/);
    await expect(betaRow).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#topics .topic-item.on')).toHaveCount(1);
    await expect(page.locator('#log')).not.toContainText(ALPHA_MSG);
    await expect(page.locator('#log')).not.toContainText(BETA_MSG);
  });

  test('mobile viewport (390x844) has no horizontal overflow and navigates topics via slide-out drawer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'mobile');
    await expect(page.locator('.wb-shell')).toBeVisible();
    await expect(page.locator('#expand-sidebar')).toBeVisible();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('#input')).toBeVisible();

    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(hasOverflow).toBe(false);

    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    const alphaRow = page.locator(`.wb-sidebar .topic-item[data-topic="${seededIds[TOPIC_ALPHA]}"]`);
    await expect(alphaRow).toBeVisible();
    await alphaRow.click();

    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-topic-title')).toContainText(TOPIC_ALPHA);
    await expect(page.locator('#input')).toBeVisible();

    await page.locator('#expand-sidebar').click();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await page.locator('.wb-drawer-backdrop').click({ position: { x: 375, y: 400 } });
    await expect(page.locator('.wb-sidebar')).toBeHidden();
  });
});

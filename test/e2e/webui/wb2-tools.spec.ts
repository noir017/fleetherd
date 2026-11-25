import fs from 'node:fs';
import path from 'node:path';
import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

const SHOTS_DIR = '/tmp/wb2-tools/shots';
const TOPIC_TITLE = 'Refactor webui tools';

let gateway: GatewayHandle;
let topicId = '';

async function ensureShotsDir(): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

async function setTheme(page: import('@playwright/test').Page, target: 'dark' | 'light'): Promise<void> {
  await page.emulateMedia({ colorScheme: target });
  const current = await page.evaluate(() => document.documentElement.dataset.theme);
  if (current === target) return;
  const themeBtn = page.locator('[data-status-id="status.theme"]');
  for (let i = 0; i < 4; i++) {
    await themeBtn.click();
    const next = await page.evaluate(() => document.documentElement.dataset.theme);
    if (next === target) return;
  }
}

test.describe('wb2-tools: changes, files, terminal, reader', () => {
  test.beforeAll(async () => {
    await ensureShotsDir();
    gateway = await startGateway();
    fs.writeFileSync(
      path.join(gateway.workDir, 'README.md'),
      '# Sample workspace\n\n## Install\n\nRun `npm ci` and `npm run build`.\n',
    );
    fs.writeFileSync(
      path.join(gateway.workDir, 'src', 'extra.ts'),
      'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
    );
    const seeded = await seedTopics(gateway, [
      { title: TOPIC_TITLE, message: 'Inspect changes and files in this workspace.' },
    ]);
    topicId = seeded.topics[TOPIC_TITLE] ?? '';
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('desktop 1440x900 dark & light: changes pane and diff editor', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator(`#topics .topic-item[data-topic="${topicId}"]`).click();
    await expect(page.locator('#topic-title')).toContainText(TOPIC_TITLE);

    // Open Changes secondary sidebar
    const changesBtn = page.locator('[data-tool-id="changes"]').first();
    await changesBtn.click();
    await expect(page.locator('.fh-changes-tool')).toBeVisible();
    await expect(page.locator('.fh-changes-summary')).toBeVisible();
    await expect(page.locator('.fh-changes-file').first()).toBeVisible();
    // Auto-selected first file renders inline diff without switching away from chat
    await expect(page.locator('.fh-changes-preview .fh-diff-viewer')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop-dark-changes.png') });

    // Light theme changes pane
    await setTheme(page, 'light');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop-light-changes.png') });
    await setTheme(page, 'dark');

    // Open single-file diff editor tab
    await page.locator('[data-open-diff-editor]').first().click();
    await expect(page.locator('.fh-diff-editor')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop-dark-diff-editor.png') });
  });

  test('desktop 1440x900 dark & light: files pane and file editor', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator(`#topics .topic-item[data-topic="${topicId}"]`).click();
    await expect(page.locator('#topic-title')).toContainText(TOPIC_TITLE);

    const filesBtn = page.locator('[data-tool-id="files"]').first();
    await filesBtn.click();
    await expect(page.locator('.fh-files-tool')).toBeVisible();
    await expect(page.locator('.fh-files-search-icon')).toBeVisible();
    const readmeRow = page.locator('.fh-tree-row', { hasText: 'README.md' }).first();
    await expect(readmeRow).toBeVisible();
    await readmeRow.click();
    await expect(page.locator('.fh-files-preview-head')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop-dark-files.png') });

    await setTheme(page, 'light');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop-light-files.png') });
    await setTheme(page, 'dark');

    // Open README.md in file editor, verify segmented Source/Preview & footer
    await page.locator('[data-files-preview-open]').click();
    await expect(page.locator('.fh-file-editor')).toBeVisible();
    await expect(page.locator('.fh-file-mode-seg')).toBeVisible();
    await expect(page.locator('.fh-file-editor-foot')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop-dark-file-editor.png') });
  });

  test('tablet 820x1100 dark & light: changes drawer', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1100 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'tablet');
    const backdrop = page.locator('.wb-drawer-backdrop');
    if (await backdrop.isVisible()) await backdrop.click();

    const changesBtn = page.locator('[data-tool-id="changes"]').first();
    await changesBtn.click();
    // Record tablet screenshot (secondary drawer visibility is owned by workbench shell)
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'tablet-dark-changes.png') });

    await setTheme(page, 'light');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'tablet-light-changes.png') });
  });

  test('mobile 390x844 dark & light: changes list, mobile diff drill-in, files list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'mobile');
    await page.locator(`.wb-stack .topic-item[data-topic="${topicId}"]`).click();

    // Switch to Changes tab in mobile stack shell
    await page.locator('.wb-stack-tool[data-tool-id="changes"]').click();
    await expect(page.locator('.fh-changes-tool')).toBeVisible();
    await expect(page.locator('.fh-changes-summary')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile-dark-changes.png') });

    // Drill into diff view on mobile
    await page.locator('.fh-changes-file-main').first().click();
    await expect(page.locator('.fh-changes-tool.is-mobile-diff')).toBeVisible();
    await expect(page.locator('.fh-changes-mobile-back')).toBeVisible();
    await expect(page.locator('.fh-changes-mobile-foot')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile-dark-diff.png') });

    // Back to list
    await page.locator('[data-changes-mobile-back]').click();
    await expect(page.locator('.fh-changes-tool.is-mobile-diff')).toHaveCount(0);

    // Switch to Files tab in mobile stack shell
    await page.locator('.wb-stack-tool[data-tool-id="files"]').click();
    await expect(page.locator('.fh-files-tool')).toBeVisible();
    await expect(page.locator('.fh-files-mpath')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile-dark-files.png') });

    // Light theme mobile check
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile-light-files.png') });
    await page.locator('.wb-stack-tool[data-tool-id="changes"]').click();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile-light-changes.png') });
  });
});

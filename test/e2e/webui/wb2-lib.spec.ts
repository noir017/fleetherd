import fs from 'node:fs';
import path from 'node:path';
import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

let gateway: GatewayHandle;
const SHOTS_DIR = process.env.WB2_LIB_SHOTS_DIR || '';

async function maybeShot(page: import('@playwright/test').Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: false });
}

test.describe('wb2-lib skills, settings, instructions, and device views', () => {
  test.beforeAll(async () => {
    gateway = await startGateway();
    const { cookie } = await seedTopics(gateway, [
      { title: 'Workbench settings topic', message: 'hello from e2e' },
    ]);

    const postSkill = async (body: unknown): Promise<void> => {
      const res = await fetch(`${gateway.baseUrl}/api/skills/op`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Seed skill failed (${res.status}): ${await res.text()}`);
    };

    await postSkill({
      action: 'create',
      name: 'deploy-check',
      description: '发版、部署前后的检查清单',
      body: '# 发版前\n\n1. git fetch，确认 main 能快进\n2. 跑 typecheck、lint 和相关测试\n',
    });
    await postSkill({ action: 'pin', name: 'deploy-check', pinned: true });
    await postSkill({
      action: 'write-file',
      name: 'deploy-check',
      file: 'references/arm64.md',
      content: '# arm64 build steps\n',
    });
    await postSkill({
      action: 'create',
      name: 'server-ops',
      description: '操作和排查服务器时使用',
      body: '# Server Ops\n',
    });
    await postSkill({
      action: 'create',
      name: 'old-deploy',
      description: '旧的部署步骤',
      body: '# Legacy\n',
    });
    await postSkill({ action: 'archive', name: 'old-deploy' });
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('desktop dark & light: skills, settings, device, and instructions', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    // Switch to zh-CN for mockup parity screenshots
    await page.locator('[data-status-id="status.locale"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    // 1. Skills sidebar & editor (dark)
    await page.locator('.wb-activity-item[data-activity-id="skills"]').click();
    await expect(page.locator('.fh-skills-view')).toBeVisible();
    await expect(page.locator('[data-skill-name="deploy-check"]')).toBeVisible();
    await page.locator('[data-list-id="deploy-check"]').click();
    await expect(page.locator('.fh-skill-ed-bar')).toBeVisible();
    await expect(page.locator('.fh-skill-card')).toHaveCount(2);
    await expect(page.locator('.fh-skill-files-box')).toBeVisible();
    await maybeShot(page, 'desktop-dark-skills');

    // Light theme for skills
    const themeBtn = page.locator('[data-status-id="status.theme"]');
    await themeBtn.click(); // dark
    await themeBtn.click(); // light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await maybeShot(page, 'desktop-light-skills');

    // Back to dark
    await themeBtn.click(); // system (dark)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // 2. Settings catalog & gateway settings
    await page.locator('.wb-activity-item[data-activity-id="settings"]').click();
    await expect(page.locator('.wb-set-catalog')).toBeVisible();
    await page.locator('.wb-set-catalog [role="option"]').first().click();
    const setEd = page.locator('.wb-set-editor:visible').first();
    await expect(setEd).toBeVisible();
    await expect(setEd.locator('.wb-set-gateway .set-card, .wb-set-gateway .ag-card').first()).toBeVisible({
      timeout: 15_000,
    });
    await maybeShot(page, 'desktop-dark-settings');

    // Light theme for settings
    await themeBtn.click(); // dark
    await themeBtn.click(); // light
    await maybeShot(page, 'desktop-light-settings');
    await themeBtn.click(); // back to dark

    // 3. Device preferences
    const devOption = page.locator('.wb-set-catalog [role="option"]').last();
    await devOption.click();
    await expect(page.locator('.fh-device-prefs-card:visible').first()).toBeVisible();
    await maybeShot(page, 'desktop-dark-device');

    // 4. Instructions editor
    const instrOption = page.locator('.wb-set-catalog [role="option"]', { hasText: /指令文件|Instruction files/ });
    await expect(instrOption).toBeVisible();
    await instrOption.click();
    await expect(page.locator('.wb-instr-editor')).toBeVisible();
    await expect(page.locator('.wb-instr-tree .fx-row').first()).toBeVisible({ timeout: 10_000 });
    await maybeShot(page, 'desktop-dark-instr');
  });

  test('tablet (820x1100) and mobile (390x844) dark & light snapshots', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator('.wb-activity-item[data-activity-id="skills"]').click();
    await expect(page.locator('.fh-skills-view')).toBeVisible();
    await page.locator('[data-list-id="deploy-check"]').click();
    await expect(page.locator('.fh-skill-ed-bar')).toBeVisible();

    // Tablet 820x1100
    await page.setViewportSize({ width: 820, height: 1100 });
    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'tablet');
    await maybeShot(page, 'tablet-dark-skills-drawer');
    const backdrop = page.locator('.wb-drawer-backdrop');
    if (await backdrop.isVisible()) await backdrop.click();
    await maybeShot(page, 'tablet-dark-skill-editor');

    // Mobile 390x844
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#workbench-root')).toHaveAttribute('data-wb-mode', 'mobile');
    await maybeShot(page, 'mobile-dark-stack');

    await page.emulateMedia({ colorScheme: 'light' });
    await maybeShot(page, 'mobile-light-stack');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';
import { seedTopics } from './seed.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

let gateway: GatewayHandle;
let seededIds: Record<string, string> = {};

const ACTIVE_TOPIC = 'API workbench topic';
const NEW_TOPIC = 'Fresh setup topic';

test.describe('wb2-api: 5 backend + frontend workbench integrations', () => {
  test.beforeAll(async () => {
    gateway = await startGateway();
    fs.mkdirSync(path.join(gateway.workDir, 'sub-a'), { recursive: true });
    fs.writeFileSync(path.join(gateway.workDir, 'README.md'), '# Modified README\n\nUpdated for git badge check.\n');
    fs.writeFileSync(path.join(gateway.workDir, 'untracked.txt'), 'new file\n');
    const seeded = await seedTopics(gateway, [
      { title: ACTIVE_TOPIC, message: 'Check status permissions and file git badges', mode: 'rich' },
      { title: NEW_TOPIC },
    ]);
    seededIds = seeded.topics;
  });

  test.afterAll(async () => {
    await gateway?.stop();
  });

  test('desktop: status bar version, new topic dir grid + one-step setup, file git badges, and permission switcher', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    // 5. Status bar displays v<package.json version>
    const versionEl = page.locator('[data-status-id="status.version"]');
    await expect(versionEl).toBeVisible();
    await expect(versionEl).toContainText(`v${PKG_VERSION}`);

    // 1. New topic shows agent cards (no flat dir grid), and picking an agent triggers the folder picker
    const newId = seededIds[NEW_TOPIC];
    expect(newId).toBeTruthy();
    await page.goto(`${gateway.baseUrl}/?t=${newId}`);
    const card = page.locator('.wb-topic-editor .launch .agent-card.def');
    await expect(card).toBeVisible();
    await expect(page.locator('.wb-topic-editor .launch .launch-dirs')).toHaveCount(0);
    const sendAgentReq = page.waitForRequest((req) => req.url().includes('/api/send') && req.method() === 'POST');
    await card.click();
    const req = await sendAgentReq;
    expect(String((req.postDataJSON() as { text?: string }).text ?? '')).toMatch(/^\/agent \S+$/);
    const picker = page.locator('.wb-topic-editor .wd-picker');
    await expect(picker).toBeVisible();
    await expect(page.locator('.wb-topic-editor #status .st-model')).toBeVisible();

    // 3. File tree shows git status badges (M for modified README.md, ? for untracked.txt)
    const activeId = seededIds[ACTIVE_TOPIC];
    expect(activeId).toBeTruthy();
    await page.goto(`${gateway.baseUrl}/?t=${activeId}`);
    await expect(page.locator('.wb-topic-editor .m').first()).toBeVisible();

    await page.locator('[data-tool-id="files"]').first().click();
    await expect(page.locator('.fh-files-tool')).toBeVisible();
    const readmeRow = page.locator('.fh-files-tree-wrap .fh-tree-row').filter({ hasText: 'README.md' }).first();
    await expect(readmeRow.locator('[data-git-status="M"]')).toBeVisible();
    const untrackedRow = page.locator('.fh-files-tree-wrap .fh-tree-row').filter({ hasText: 'untracked.txt' }).first();
    await expect(untrackedRow.locator('[data-git-status="?"]')).toBeVisible();

    // 4. Status row shows permission chip and switches via /setting permissions.<agent> <level>
    const permBtn = page.locator('.wb-topic-editor #status .st-perm');
    await expect(permBtn).toBeVisible();
    await permBtn.click();
    const pop = page.locator('.wb-topic-editor #model-pop');
    await expect(pop).toBeVisible();
    const askOpt = pop.locator('.mp-opt[data-v="ask"]');
    await expect(askOpt).toBeVisible();
    const sendReq = page.waitForRequest((r) => r.url().includes('/api/send') && r.method() === 'POST');
    await askOpt.click();
    const sent = await sendReq;
    expect(String((sent.postDataJSON() as { text?: string }).text ?? '')).toMatch(/^\/setting permissions\.\S+ ask$/);
    await expect(permBtn).toContainText('ask');
  });

  test('desktop: review detail shows reviewer/model/messages/duration, inline diff, and confirmed revert', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let revertedBody: Record<string, unknown> | null = null;
    const mockList = {
      enabled: true,
      running: true,
      pending: [],
      reviews: [
        {
          id: 'review:web#main#11111111:1',
          title: 'Deploy notes for 3.39',
          at: Date.UTC(2026, 10, 25, 9, 40),
          outcome: 'changed',
          summary: '1 skill change',
          reviewer: 'ag@buildbox',
          model: 'gemini-3.8-flash',
          messagesRead: 18,
          durationMs: 130_000,
          changes: [
            {
              action: 'patch',
              name: 'deploy-check',
              reason: 'Add git fetch before tagging',
              applied: true,
              revertId: 'abcdef1',
              diff: 'diff --git a/skills/deploy-check/SKILL.md b/skills/deploy-check/SKILL.md\n@@ -1,2 +1,3 @@\n # Deploy\n+1. Run git fetch first\n 2. Run tests',
            },
          ],
          preferences: [],
          invalid: [],
        },
      ],
    };
    await page.route('**/api/reviews', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockList) }));
    await page.route('**/api/reviews/op', async (route) => {
      revertedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockList) });
    });

    await loginViaUi(page, gateway.baseUrl, gateway.secret);
    await page.locator('[data-activity-id="reviews"]').first().click();
    const revRow = page.locator('.fh-reviews-view [data-rev]').first();
    await expect(revRow).toBeVisible();
    await revRow.click();

    const meta = page.locator('.fh-review-editor [data-rev-meta]');
    await expect(meta).toContainText('ag@buildbox');
    await expect(meta).toContainText('gemini-3.8-flash');
    await expect(meta).toContainText('18');
    await expect(meta).toContainText('2m 10s');

    const diffEl = page.locator('.fh-review-editor [data-rev-diff]');
    await expect(diffEl).toBeVisible();
    await expect(diffEl).toContainText('+1. Run git fetch first');

    const revertBtn = page.locator('.fh-review-editor [data-rev-revert="abcdef1"]');
    await expect(revertBtn).toBeVisible();
    await revertBtn.click();

    const confirmBtn = page.locator('.fh-dialog .fh-btn--danger, .fh-dialog [data-dialog-confirm]').first();
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();
    await expect.poll(() => revertedBody).toEqual({ action: 'revert', name: 'deploy-check', id: 'abcdef1' });
  });

  test('mobile: new topic dir grid and status permission chip render cleanly', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const activeRow = page.locator('.wb-stack-list-body .topic-item').filter({ hasText: ACTIVE_TOPIC }).first();
    await expect(activeRow).toBeVisible();
    await activeRow.click();
    await expect(page.locator('.wb-stack-detail-body .wb-topic-editor #status .st-perm')).toBeVisible();
  });
});

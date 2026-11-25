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
const MOBILE_NEW_TOPIC = 'Fresh mobile topic';

const MOCK_REVIEW_LIST = {
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

test.beforeAll(async () => {
  gateway = await startGateway();
  fs.mkdirSync(path.join(gateway.workDir, 'sub-a', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(gateway.workDir, 'sub-b'), { recursive: true });
  fs.writeFileSync(path.join(gateway.workDir, 'README.md'), '# Modified README\n\nUpdated for git badge check.\n');
  fs.writeFileSync(path.join(gateway.workDir, 'untracked.txt'), 'new file\n');
  const seeded = await seedTopics(gateway, [
    { title: ACTIVE_TOPIC, message: 'Check status permissions and file git badges', mode: 'rich' },
    { title: NEW_TOPIC },
    { title: MOBILE_NEW_TOPIC },
  ]);
  seededIds = seeded.topics;
});

test.afterAll(async () => {
  await gateway?.stop();
});

test.describe('wb2-api: desktop workbench integrations', () => {

  test('desktop: status bar version, inline new topic agent + folder picker, file git badges, and permission switcher', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    // 5. Status bar displays v<package.json version>
    const versionEl = page.locator('[data-status-id="status.version"]');
    await expect(versionEl).toBeVisible();
    await expect(versionEl).toContainText(`v${PKG_VERSION}`);

    // 1. New topic shows agent cards AND inline folder browser on the same page; both can be picked in any order
    const newId = seededIds[NEW_TOPIC];
    expect(newId).toBeTruthy();
    await page.goto(`${gateway.baseUrl}/?t=${newId}`);
    const launchEl = page.locator('.wb-topic-editor .launch');
    await expect(launchEl.locator('.agent-card.def')).toBeVisible();
    await expect(page.locator('.wb-topic-editor .launch .launch-dirs')).toHaveCount(0);
    const picker = launchEl.locator('.launch-wd .wd-picker');
    await expect(picker).toBeVisible();
    await expect(launchEl.locator('.launch-choice-agent')).toContainText('alpha');
    await expect(launchEl.locator('.launch-choice-dir')).toContainText(gateway.workDir);

    // Browse into sub-a, see nested, then go Up without leaving the page
    await picker.locator('.wd-open').filter({ hasText: 'sub-a' }).first().click();
    await expect(picker.locator('.wd-row').filter({ hasText: 'nested' })).toBeVisible();
    await picker.locator('.wd-up').click();
    await expect(picker.locator('.wd-row').filter({ hasText: 'sub-a' })).toBeVisible();

    // Pick agent beta in place (resets browser to beta's root and shows model switch immediately)
    const agentSetupReq = page.waitForRequest((req) => req.url().includes('/api/topics/setup') && req.method() === 'POST');
    await launchEl.locator('.agent-card[data-agent="beta"]').click();
    const agentReq = await agentSetupReq;
    expect(agentReq.postDataJSON()).toMatchObject({ topic: newId, agent: 'beta' });
    await expect(launchEl.locator('.agent-card[data-agent="beta"]')).toHaveClass(/\bdef\b/);
    await expect(launchEl.locator('.launch-choice-agent')).toContainText('beta');
    await expect(page.locator('.wb-topic-editor #status .st-model:not(.st-opt)')).toBeVisible();
    await expect(page.locator('.wb-topic-editor #status .st-perm')).toBeVisible();

    // Pick folder sub-a on the same page
    const subAPath = path.join(gateway.workDir, 'sub-a');
    const dirSetupReq = page.waitForRequest((req) => req.url().includes('/api/topics/setup') && req.method() === 'POST');
    await picker.locator('.wd-row').filter({ hasText: 'sub-a' }).locator('.wd-choose').click();
    const dirReq = await dirSetupReq;
    expect(dirReq.postDataJSON()).toMatchObject({ topic: newId, agent: 'beta', cwd: subAPath });
    await expect(launchEl.locator('.launch-choice-dir')).toContainText(subAPath);
    await expect(page.locator('.wb-topic-editor .m')).toHaveCount(0);


    // Send first message and verify the topic runs in beta at sub-a
    await page.locator('.wb-topic-editor #input').fill('Launch check message');
    await page.locator('.wb-topic-editor #composer button[type="submit"]').click();
    await expect(page.locator('.wb-topic-editor .m').filter({ hasText: 'Launch check message' })).toBeVisible();
    await expect(page.locator('.wb-topic-editor .launch')).toHaveCount(0);
    await expect(page.locator('.wb-topic-editor #log')).toContainText('echo(beta): Launch check message', { timeout: 15_000 });
    const promptLog = fs.readFileSync(gateway.promptLogFile, 'utf8');
    expect(promptLog).toContain('Launch check message');

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
});

test.describe('wb2-api: reviews and mobile workbench integrations', () => {

  test('desktop: review detail shows reviewer/model/messages/duration, inline diff, and confirmed revert', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let revertedBody: Record<string, unknown> | null = null;
    await page.route('**/api/reviews', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_REVIEW_LIST) }));
    await page.route('**/api/reviews/op', async (route) => {
      revertedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_REVIEW_LIST) });
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

  test('mobile: inline new topic agent + folder picker and status permission chip render cleanly', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await page.locator('#expand-sidebar').click();
    const activeRow = page.locator('.wb-sidebar .topic-item').filter({ hasText: ACTIVE_TOPIC }).first();
    await expect(activeRow).toBeVisible();
    await activeRow.click();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    await expect(page.locator('.wb-topic-editor #status .st-perm')).toBeVisible();

    await page.locator('#expand-sidebar').click();
    const freshRow = page.locator('.wb-sidebar .topic-item').filter({ hasText: MOBILE_NEW_TOPIC }).first();
    await expect(freshRow).toBeVisible();
    await freshRow.click();
    await expect(page.locator('.wb-sidebar')).toBeHidden();
    const mobileLaunch = page.locator('.wb-topic-editor .launch');
    await expect(mobileLaunch.locator('.agent-card.def')).toBeVisible();
    await expect(page.locator('.wb-topic-editor .launch .launch-dirs')).toHaveCount(0);
    const mobilePicker = mobileLaunch.locator('.launch-wd .wd-picker');
    await expect(mobilePicker).toBeVisible();
    const subAPath = path.join(gateway.workDir, 'sub-a');
    const mobileDirReq = page.waitForRequest((req) => req.url().includes('/api/topics/setup') && req.method() === 'POST');
    await mobilePicker.locator('.wd-row').filter({ hasText: 'sub-a' }).locator('.wd-choose').click();
    expect((await mobileDirReq).postDataJSON()).toMatchObject({ cwd: subAPath });
    await expect(mobileLaunch.locator('.launch-choice-dir')).toContainText(subAPath);
    await expect(page.locator('.wb-topic-editor #status .st-model:not(.st-opt)')).toBeVisible();
    await expect(page.locator('.wb-topic-editor #status .st-perm')).toBeVisible();
  });
});

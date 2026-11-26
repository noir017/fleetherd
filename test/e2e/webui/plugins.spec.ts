import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, loginViaUi } from './fixtures.js';
import { startGateway, type GatewayHandle } from './harness.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELLO_PLUGIN_SRC = path.resolve(THIS_DIR, '../../../examples/webui-plugin-hello');

function createTempPluginsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-e2e-plugins-'));
}

function copyHelloPlugin(root: string): string {
  const dest = path.join(root, 'hello');
  fs.cpSync(HELLO_PLUGIN_SRC, dest, { recursive: true });
  return dest;
}

function createBrokenPlugin(root: string, id = 'broken-boom'): string {
  const dest = path.join(root, id);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, 'fleetherd-plugin.json'),
    JSON.stringify(
      {
        id,
        name: 'Broken Plugin',
        version: '0.1.0',
        client: 'client.mjs',
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(dest, 'client.mjs'),
    [
      'export default {',
      `  id: ${JSON.stringify(id)},`,
      '  activate() {',
      "    throw new Error('intentional activate failure');",
      '  },',
      '};',
      '',
    ].join('\n')
  );
  return dest;
}

test.describe('Web UI external plugins: hello loading, auth, and asset allowlist', () => {
  let pluginsRoot = '';
  let gateway: GatewayHandle;

  test.beforeAll(async () => {
    pluginsRoot = createTempPluginsRoot();
    const helloDir = copyHelloPlugin(pluginsRoot);
    gateway = await startGateway({
      plugins: [{ path: helloDir, config: { greeting: 'Hi from E2E' } }],
    });
  });

  test.afterAll(async () => {
    await gateway?.stop();
    if (pluginsRoot) {
      fs.rmSync(pluginsRoot, { recursive: true, force: true });
    }
  });

  test('loads example hello plugin end-to-end (status bar, sidebar view, and /api/plugins/hello/ping)', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('link[rel="stylesheet"][data-plugin-id="hello"]')).toHaveCount(1);

    const statusItem = page.locator('[data-status-id="hello.status"]');
    await expect(statusItem).toBeVisible();
    await expect(statusItem).toHaveText('Hello');

    const activityBtn = page.locator('.wb-activity-item[data-activity-id="hello.activity"]');
    await expect(activityBtn).toBeVisible();
    await activityBtn.click();
    await expect(activityBtn).toHaveClass(/\bis-active\b/);

    const helloView = page.locator('.fh-hello-view');
    await expect(helloView).toBeVisible();
    await expect(helloView.locator('.fh-hello-header')).toHaveText('Hello Plugin');

    const pingPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/plugins/hello/ping') && res.request().method() === 'GET'
    );
    await helloView.locator('.fh-hello-btn').click();
    const pingRes = await pingPromise;
    expect(pingRes.status()).toBe(200);

    const payload = (await pingRes.json()) as {
      ok: boolean;
      id: string;
      greeting: string;
      count: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.id).toBe('hello');
    expect(payload.greeting).toBe('Hi from E2E');
    expect(payload.count).toBeGreaterThanOrEqual(1);

    await expect(helloView).toContainText(`Hi from E2E (#${payload.count},`);
    await expect(statusItem).toHaveText(`Hello (${payload.count})`);
    await expect(page.locator('[data-status-id="status.pluginErrors"]')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('enforces 401 on unauthenticated plugin routes and 404 on non-whitelisted or traversal assets', async ({
    page,
  }) => {
    const unauthApi = await fetch(`${gateway.baseUrl}/api/plugins/hello/ping`);
    expect(unauthApi.status).toBe(401);

    const unauthAsset = await fetch(`${gateway.baseUrl}/plugins/hello/client.mjs`);
    expect(unauthAsset.status).toBe(401);

    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    const allowedClient = await page.request.get(`${gateway.baseUrl}/plugins/hello/client.mjs`);
    expect(allowedClient.status()).toBe(200);

    const allowedStyle = await page.request.get(`${gateway.baseUrl}/plugins/hello/style.css`);
    expect(allowedStyle.status()).toBe(200);

    const serverModule = await page.request.get(`${gateway.baseUrl}/plugins/hello/server.mjs`);
    expect(serverModule.status()).toBe(404);

    const manifestFile = await page.request.get(`${gateway.baseUrl}/plugins/hello/fleetherd-plugin.json`);
    expect(manifestFile.status()).toBe(404);

    for (const traversalPath of [
      '/plugins/hello/..%2F..%2Fpackage.json',
      '/plugins/hello/%2e%2e/hello/server.mjs',
      '/plugins/hello/..%2Fhello%2Fserver.mjs',
    ]) {
      const res = await page.request.get(`${gateway.baseUrl}${traversalPath}`);
      expect(res.status(), `expected 404 for ${traversalPath}`).toBe(404);
    }
  });
});

test.describe('Web UI external plugins: error isolation', () => {
  let pluginsRoot = '';
  let gateway: GatewayHandle;

  test.beforeAll(async () => {
    pluginsRoot = createTempPluginsRoot();
    const brokenDir = createBrokenPlugin(pluginsRoot, 'broken-boom');
    const helloDir = copyHelloPlugin(pluginsRoot);
    gateway = await startGateway({
      plugins: [
        { path: brokenDir },
        { path: helloDir, config: { greeting: 'Still alive' } },
      ],
    });
  });

  test.afterAll(async () => {
    await gateway?.stop();
    if (pluginsRoot) {
      fs.rmSync(pluginsRoot, { recursive: true, force: true });
    }
  });

  test('isolates a throwing plugin without breaking workbench or sibling plugins and shows status bar warning', async ({
    page,
  }) => {
    await loginViaUi(page, gateway.baseUrl, gateway.secret);

    await expect(page.locator('#workbench-root')).toBeVisible();
    await expect(page.locator('.wb-activity-bar')).toBeVisible();
    await expect(page.locator('.wb-sidebar')).toBeVisible();
    await expect(page.locator('.wb-editor-area')).toBeVisible();
    await expect(page.locator('.wb-status-bar')).toBeVisible();

    const helloStatus = page.locator('[data-status-id="hello.status"]');
    await expect(helloStatus).toBeVisible();
    await expect(helloStatus).toHaveText('Hello');

    const helloActivity = page.locator('.wb-activity-item[data-activity-id="hello.activity"]');
    await expect(helloActivity).toBeVisible();
    await helloActivity.click();

    const helloView = page.locator('.fh-hello-view');
    await expect(helloView).toBeVisible();

    const pingPromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/plugins/hello/ping') && res.request().method() === 'GET'
    );
    await helloView.locator('.fh-hello-btn').click();
    expect((await pingPromise).status()).toBe(200);
    await expect(helloView).toContainText('Still alive (#1,');

    const errorStatus = page.locator('[data-status-id="status.pluginErrors"]');
    await expect(errorStatus).toBeVisible();
    await expect(errorStatus).toHaveClass(/\bis-warn\b/);
    await expect(errorStatus).toContainText('1 plugin error');

    await errorStatus.click();
    const dialog = page.getByRole('dialog', { name: 'Plugin errors (1)' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('broken-boom');
    await expect(dialog).toContainText('intentional activate failure');
  });
});

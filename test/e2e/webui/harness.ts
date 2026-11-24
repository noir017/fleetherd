import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type FakeAgentMode = 'ok' | 'rich' | 'slow' | 'prompt-error' | 'refuse' | 'hang';

export const TEST_SECRET = 'e2e-test-secret-token';

export interface GatewayOptions {
  secret?: string;
  title?: string;
  initialMode?: FakeAgentMode;
  readyTimeoutMs?: number;
}

export interface GatewayHandle {
  readonly baseUrl: string;
  readonly port: number;
  readonly secret: string;
  readonly rootDir: string;
  readonly workDir: string;
  readonly modeFile: string;
  readonly promptLogFile: string;
  setMode(mode: FakeAgentMode): void;
  readLogs(): string;
  stop(): Promise<void>;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../..');
const FAKE_AGENT_SCRIPT = path.join(THIS_DIR, 'fake-agent.mjs');

const activeChildren = new Set<{ child: ChildProcess; rootDir: string }>();
let cleanupRegistered = false;

function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', () => {
    for (const entry of activeChildren) {
      if (entry.child.exitCode === null) {
        try {
          entry.child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      try {
        fs.rmSync(entry.rootDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    activeChildren.clear();
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to resolve ephemeral port')));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Strip FLEETHERD_* and TALKCODE_* so the isolated daemon never inherits a live agent's environment.
function buildIsolatedEnv(homeDir: string, configPath: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith('FLEETHERD_') ||
      key.startsWith('TALKCODE_') ||
      key === 'CLAUDECODE' ||
      key === 'CLAUDE_CODE_ENTRYPOINT'
    ) {
      continue;
    }
    clean[key] = value;
  }
  clean.HOME = homeDir;
  clean.FLEETHERD_CONFIG_FILE = configPath;
  clean.FLEETHERD_NO_SKILL_LINK = '1';
  clean.FLEETHERD_NO_AGY_STATUSLINE = '1';
  return clean;
}

function initSampleGitRepo(workDir: string): void {
  fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'README.md'), '# Sample workspace\n');
  fs.writeFileSync(path.join(workDir, 'src', 'sample.ts'), 'export const value = 1;\n');
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: workDir, stdio: 'ignore' });
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-qm', 'init']);
  fs.writeFileSync(path.join(workDir, 'src', 'sample.ts'), 'export const value = 2;\n');
}

function buildConfigYaml(params: {
  port: number;
  secret: string;
  title: string;
  workDir: string;
  attachmentsDir: string;
  modeFile: string;
  promptLogFile: string;
}): string {
  const quote = (value: string): string => JSON.stringify(value);
  return [
    'version: 1',
    'platforms:',
    '  web:',
    '    type: webui',
    `    token: ${quote(params.secret)}`,
    '    host: 127.0.0.1',
    `    port: ${params.port}`,
    `    title: ${quote(params.title)}`,
    '    autoRenameThread: false',
    '    files:',
    '      enabled: true',
    '    instructions:',
    '      enabled: true',
    'agents:',
    '  - id: alpha',
    '    harness: custom',
    '    command: node',
    `    args: [${quote(FAKE_AGENT_SCRIPT)}]`,
    `    cwd: ${quote(params.workDir)}`,
    '    env:',
    '      FAKE_AGENT: alpha',
    `      FAKE_MODE: ${quote(params.modeFile)}`,
    `      FAKE_LOG: ${quote(params.promptLogFile)}`,
    '  - id: beta',
    '    harness: custom',
    '    command: node',
    `    args: [${quote(FAKE_AGENT_SCRIPT)}]`,
    `    cwd: ${quote(params.workDir)}`,
    '    env:',
    '      FAKE_AGENT: beta',
    `      FAKE_MODE: ${quote(params.modeFile)}`,
    `      FAKE_LOG: ${quote(params.promptLogFile)}`,
    'routing:',
    '  default: alpha',
    'attachments:',
    `  cacheDir: ${quote(params.attachmentsDir)}`,
    'session:',
    '  idleTimeoutMs: 3600000',
    '',
  ].join('\n');
}

async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  getLogs: () => string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway exited early (code ${child.exitCode}):\n${getLogs()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway did not become ready at ${baseUrl} within ${timeoutMs}ms:\n${getLogs()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function startGateway(options: GatewayOptions = {}): Promise<GatewayHandle> {
  registerProcessCleanup();
  const secret = options.secret ?? TEST_SECRET;
  const title = options.title ?? 'fleetherd-e2e';
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const port = await findFreePort();

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-e2e-'));
  const homeDir = path.join(rootDir, 'home');
  const workDir = path.join(rootDir, 'work');
  const attachmentsDir = path.join(rootDir, 'attachments');
  const configPath = path.join(rootDir, 'config.yaml');
  const modeFile = path.join(rootDir, 'mode');
  const promptLogFile = path.join(rootDir, 'prompts.log');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  initSampleGitRepo(workDir);
  fs.writeFileSync(modeFile, options.initialMode ?? 'ok');
  fs.writeFileSync(promptLogFile, '');
  fs.writeFileSync(
    configPath,
    buildConfigYaml({ port, secret, title, workDir, attachmentsDir, modeFile, promptLogFile })
  );

  const logs: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'start'], {
    cwd: REPO_ROOT,
    env: buildIsolatedEnv(homeDir, configPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));

  const tracked = { child, rootDir };
  activeChildren.add(tracked);

  const baseUrl = `http://127.0.0.1:${port}`;
  const readLogs = (): string => logs.join('');

  const stop = async (): Promise<void> => {
    activeChildren.delete(tracked);
    await stopChild(child);
    fs.rmSync(rootDir, { recursive: true, force: true });
  };

  try {
    await waitForReady(baseUrl, child, readLogs, readyTimeoutMs);
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    baseUrl,
    port,
    secret,
    rootDir,
    workDir,
    modeFile,
    promptLogFile,
    setMode: (mode: FakeAgentMode) => fs.writeFileSync(modeFile, mode),
    readLogs,
    stop,
  };
}

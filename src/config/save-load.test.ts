import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfigPatch } from './load.js';

/**
 * End-to-end file behavior of the new load/save pipeline:
 * - loadConfig: v0 in-memory migration + ${VAR} expansion (+ .env sidecar).
 * - saveConfigPatch: comment-preserving partial writes via the yaml Document API.
 * Each test points FLEETHERD_CONFIG_FILE at a temp file.
 */

let dir: string;
let file: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-cfg-'));
  file = path.join(dir, 'config.yaml');
  savedEnv.FLEETHERD_CONFIG_FILE = process.env.FLEETHERD_CONFIG_FILE;
  savedEnv.MY_TEST_TOKEN = process.env.MY_TEST_TOKEN;
  process.env.FLEETHERD_CONFIG_FILE = file;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const V1_YAML = `# my deployment
version: 1
platforms:
  discord:
    type: discord
    token: \${MY_TEST_TOKEN}
agents:
  - id: a
    harness: claude
routing:
  default: a
`;

describe('loadConfig', () => {
  it('expands ${VAR} from process env; the file itself keeps the template', () => {
    fs.writeFileSync(file, V1_YAML);
    process.env.MY_TEST_TOKEN = 'tok-from-env';
    const cfg = loadConfig();
    const inst = Object.values(cfg.platforms)[0]!;
    expect(inst.type === 'discord' && inst.token).toBe('tok-from-env');
    expect(fs.readFileSync(file, 'utf8')).toContain('${MY_TEST_TOKEN}'); // never expanded on disk
  });

  it('fills ${VAR} from the .env sidecar without overriding process env', () => {
    fs.writeFileSync(file, V1_YAML);
    delete process.env.MY_TEST_TOKEN;
    fs.writeFileSync(path.join(dir, '.env'), 'MY_TEST_TOKEN=tok-from-dotenv\n');
    const cfg = loadConfig();
    const inst = Object.values(cfg.platforms)[0]!;
    expect(inst.type === 'discord' && inst.token).toBe('tok-from-dotenv');
  });

  it('reports ALL missing ${VAR}s with paths in one error', () => {
    fs.writeFileSync(file, V1_YAML.replace('\\${MY_TEST_TOKEN}', '${DEFINITELY_MISSING_VAR}'));
    delete process.env.MY_TEST_TOKEN;
    expect(() => loadConfig()).toThrowError(/undefined environment variables/);
  });

  it('auto-migrates a v0 file in memory (file untouched)', () => {
    fs.writeFileSync(
      file,
      [
        'platform:',
        '  type: discord',
        '  token: t0',
        '  channels: [c9]',
        'agents:',
        '  - id: a',
        '    harness: claude',
        'routing:',
        '  default: a',
      ].join('\n')
    );
    const cfg = loadConfig();
    const [id, inst] = Object.entries(cfg.platforms)[0]!;
    expect(id).toBe('discord');
    expect(inst.type === 'discord' && inst.token).toBe('t0');
    expect(inst.chat.channels).toEqual(['c9']);
    expect(fs.readFileSync(file, 'utf8')).toContain('platform:'); // load never rewrites the file
  });
});

describe('saveConfigPatch', () => {
  it('updates only the patched paths and preserves comments elsewhere', () => {
    fs.writeFileSync(file, V1_YAML + 'session:\n  # keep me: hand-tuned\n  futureKnob: 45\n  scope: per_user\n');
    saveConfigPatch([
      { path: ['session', 'scope'], value: 'per_thread' },
      { path: ['access', 'allowFrom'], value: ['discord:1'] },
    ]);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# my deployment'); // file-level comment survives
    expect(text).toContain('# keep me: hand-tuned'); // sibling-key comment survives
    expect(text).toContain('futureKnob: 45'); // untouched (schema-unknown) sibling survives
    expect(text).toContain('scope: per_thread'); // patched
    expect(text).toContain('${MY_TEST_TOKEN}'); // template not expanded by save
    expect(text).toMatch(/allowFrom:\s*\n\s+- discord:1|allowFrom:\s*\[\s*discord:1/); // created section
  });

  it('creates the file from scratch when none exists', () => {
    saveConfigPatch([{ path: ['version'], value: 1 }]);
    expect(fs.readFileSync(file, 'utf8')).toContain('version: 1');
  });
});

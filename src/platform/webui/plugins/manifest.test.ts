import { describe, expect, it } from 'vitest';

import { WebuiConfigSchema } from '../../../config/platform-schemas.js';
import {
  isSafeAssetPattern,
  isSafeRelativePath,
  parsePluginManifest,
  PluginManifestSchema,
  RESERVED_PLUGIN_IDS,
} from './manifest.js';

describe('WebuiConfigSchema plugins field', () => {
  it('defaults plugins to an empty array', () => {
    const parsed = WebuiConfigSchema.parse({ type: 'webui', token: 'secret' });
    expect(parsed.plugins).toEqual([]);
  });

  it('accepts valid plugin entries with optional config', () => {
    const parsed = WebuiConfigSchema.parse({
      type: 'webui',
      token: 'secret',
      plugins: [
        { path: '/opt/fleetherd-plugins/hello' },
        { path: '/opt/fleetherd-plugins/custom', config: { greeting: 'hi', nested: [1, 2] } },
      ],
    });
    expect(parsed.plugins).toEqual([
      { path: '/opt/fleetherd-plugins/hello' },
      { path: '/opt/fleetherd-plugins/custom', config: { greeting: 'hi', nested: [1, 2] } },
    ]);
  });

  it('rejects empty plugin path and unknown keys via strict()', () => {
    expect(
      WebuiConfigSchema.safeParse({
        type: 'webui',
        token: 'secret',
        plugins: [{ path: '' }],
      }).success
    ).toBe(false);

    expect(
      WebuiConfigSchema.safeParse({
        type: 'webui',
        token: 'secret',
        plugins: [{ path: '/opt/fleetherd-plugins/hello', extra: true }],
      }).success
    ).toBe(false);
  });
});

describe('PluginManifestSchema', () => {
  it('accepts a valid minimal and full manifest', () => {
    const minimal = parsePluginManifest({
      id: 'hello-world',
      name: 'Hello World',
      version: '1.0.0',
    });
    expect(minimal.ok).toBe(true);

    const full = parsePluginManifest({
      id: 'hello-1',
      name: 'Hello Plugin',
      version: '0.2.0',
      engines: { fleetherdWebui: '^1.0.0' },
      client: 'dist/client.js',
      style: 'dist/style.css',
      server: 'dist/server.mjs',
      assets: ['dist/assets/**', 'icons/*.svg'],
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.manifest.engines?.fleetherdWebui).toBe('^1.0.0');
      expect(full.manifest.assets).toEqual(['dist/assets/**', 'icons/*.svg']);
    }
  });

  it('rejects unknown fields in root and engines via strict()', () => {
    expect(
      PluginManifestSchema.safeParse({
        id: 'hello-world',
        name: 'Hello',
        version: '1.0.0',
        unknownField: 123,
      }).success
    ).toBe(false);

    expect(
      PluginManifestSchema.safeParse({
        id: 'hello-world',
        name: 'Hello',
        version: '1.0.0',
        engines: { fleetherdWebui: '^1.0.0', extra: 'no' },
      }).success
    ).toBe(false);
  });

  it('validates plugin id pattern /^[a-z][a-z0-9-]{1,40}$/', () => {
    const invalidIds = [
      '',
      'a', // too short (1 char)
      'A-plugin', // uppercase
      '1-plugin', // starts with digit
      '-plugin', // starts with hyphen
      'bad_id', // underscore
      'bad/id', // slash
      `a${'b'.repeat(41)}`, // 42 chars (> 41)
    ];
    for (const id of invalidIds) {
      const res = parsePluginManifest({ id, name: 'Test', version: '1.0.0' });
      expect(res.ok, `expected "${id}" to fail`).toBe(false);
    }

    expect(parsePluginManifest({ id: 'ab', name: 'Min', version: '1.0.0' }).ok).toBe(true);
    expect(parsePluginManifest({ id: `a${'b'.repeat(40)}`, name: 'Max', version: '1.0.0' }).ok).toBe(true);
  });

  it('rejects all reserved built-in plugin ids', () => {
    const expectedBuiltins = [
      'topics',
      'topic',
      'history',
      'schedules',
      'reviews',
      'skills',
      'settings',
      'changes',
      'files',
      'terminal',
      'reader',
      'status',
      'palette',
    ];
    expect([...RESERVED_PLUGIN_IDS].sort()).toEqual([...expectedBuiltins].sort());
    for (const id of expectedBuiltins) {
      const res = parsePluginManifest({ id, name: 'Collision', version: '1.0.0' });
      expect(res.ok, `expected built-in id "${id}" to be rejected`).toBe(false);
      if (!res.ok) expect(res.error).toContain('built-in');
    }
  });

  it('rejects unsafe relative paths for client, style, server, and assets', () => {
    const badPaths = [
      '/etc/passwd',
      '../escape.js',
      'dist/../../escape.js',
      './dist/client.js',
      'dist\\client.js',
      'C:/Windows/win.ini',
      'dist//client.js',
      'dist/client.js\0.txt',
      'dist/*.js',
    ];
    for (const p of badPaths) {
      expect(isSafeRelativePath(p), `expected "${p}" to be unsafe`).toBe(false);
      expect(
        parsePluginManifest({ id: 'hello-ok', name: 'Hello', version: '1.0.0', client: p }).ok
      ).toBe(false);
    }

    expect(isSafeAssetPattern('dist/assets/**')).toBe(true);
    expect(isSafeAssetPattern('icons/logo-?.svg')).toBe(true);
    expect(isSafeAssetPattern('../secret/**')).toBe(false);
    expect(isSafeAssetPattern('/etc/**')).toBe(false);
    expect(isSafeAssetPattern('dist\\assets\\*')).toBe(false);
  });
});

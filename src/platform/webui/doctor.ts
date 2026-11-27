import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/schema.js';
import type { Locale } from '../../core/i18n/index.js';
import { tCli } from '../../core/i18n/cli.js';
import { loadSinglePlugin } from './plugins/loader.js';
import { OWNER } from './room.js';
import { loadJwks } from './sso.js';

/** Whether a host:port can be bound right now. Binds and releases; never leaves it held. */
async function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** Validate configured Web UI plugins against forbidden roots and format the doctor summary line (security invariant 12). */
export function inspectWebuiPlugins(
  id: string,
  plugins: readonly { path: string; config?: unknown }[],
  filesRoots: readonly string[],
  cfg: Config,
  locale: Locale
): string {
  const agentRoots = cfg.agents
    .filter((a) => !a.host)
    .flatMap((a) => [a.cwd, path.join(os.homedir(), '.fleetherd', 'agents', a.id)].filter((x): x is string => Boolean(x)));
  const forbiddenRoots = [...filesRoots, ...agentRoots];
  const seenIds = new Set<string>();
  const items = plugins.map((entry) => {
    const result = loadSinglePlugin(entry, forbiddenRoots, seenIds);
    if (result.ok) {
      seenIds.add(result.plugin.id);
      return `${entry.path} (${result.plugin.id}@${result.plugin.version} ✓)`;
    }
    return `${entry.path} (✗ ${result.reason})`;
  });
  return tCli(locale, 'doctor.detail.webuiPlugins', {
    id,
    count: plugins.length,
    list: items.join(', '),
  });
}

/** Doctor check for all configured Web UI instances (port availability, allowFrom owner, plain HTTP, SSO JWKS, plugins). */
export async function checkWebui(
  cfg: Config | null,
  locale: Locale
): Promise<{ ok: boolean; level?: 'warn'; detail?: string }> {
  if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableWebui') };
  const uis = Object.entries(cfg.platforms).filter(([, p]) => p.type === 'webui');
  if (uis.length === 0) return { ok: true, detail: tCli(locale, 'doctor.detail.webuiSkipped') };
  const lines: string[] = [];
  let warn = false;
  for (const [id, p] of uis) {
    if (p.type !== 'webui') continue;
    const free = await portFree(p.host, p.port);
    if (!free) {
      warn = true;
      lines.push(tCli(locale, 'doctor.detail.webuiPortInUse', { id, host: p.host, port: p.port }));
    } else {
      lines.push(tCli(locale, 'doctor.detail.webuiPortFree', { id, host: p.host, port: p.port }));
    }
    const identity = `${id}:${OWNER}`;
    if (cfg.access.allowFrom.length > 0 && !cfg.access.allowFrom.includes(identity)) {
      warn = true;
      lines.push(tCli(locale, 'doctor.detail.webuiAllowFromMissing', { id, identity }));
    }
    if (p.host !== '127.0.0.1' && p.host !== 'localhost' && p.host !== '::1') {
      warn = true;
      lines.push(tCli(locale, 'doctor.detail.webuiPlainHttp', { id, host: p.host }));
    }
    if (p.sso) {
      try {
        const keys = await loadJwks(p.sso.jwksUrl);
        lines.push(
          tCli(locale, 'doctor.detail.webuiSsoKeys', {
            id,
            header: p.sso.header,
            from: p.sso.from.join(', '),
            count: keys.size,
            url: p.sso.jwksUrl,
          })
        );
      } catch (e) {
        warn = true;
        lines.push(
          tCli(locale, 'doctor.detail.webuiSsoError', {
            id,
            url: p.sso.jwksUrl,
            error: e instanceof Error ? e.message : String(e),
          })
        );
      }
      if (p.sso.password) {
        lines.push(tCli(locale, 'doctor.detail.webuiSsoPassword', { id }));
      }
    }
    if (p.plugins.length > 0) {
      warn = true;
      lines.push(inspectWebuiPlugins(id, p.plugins, p.files.roots, cfg, locale));
    }
  }
  return { ok: true, ...(warn ? { level: 'warn' as const } : {}), detail: lines.join('; ') };
}

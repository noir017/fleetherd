import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import type { AgentDef } from '../config/schema.js';
import { buildHarnessEnv, remoteAgentEnv } from './agent-common.js';
import { claudeHeaderPools } from './claude-rate-limit.js';
import type { QuotaReading } from './harness/profile.js';
import { remoteHosts } from './remote-hosts.js';

const execFile = promisify(execFileCb);

/**
 * A claude behind a relay (`ANTHROPIC_BASE_URL`) gets no rate-limit events — Claude Code reads the
 * `anthropic-ratelimit-unified-*` headers only on a claude.ai login — but a relay fronting
 * subscription accounts passes those headers on. So this asks: a one-token `/v1/messages` with the
 * agent's own URL, key and cheapest model, sent from the agent's machine, read for its headers.
 * How often is the claude profile's (harness/claude.ts), when is quota-meter.ts's.
 */

/** The model probed when the agent's environment names no ANTHROPIC_DEFAULT_HAIKU_MODEL. */
export const CLAUDE_PROBE_MODEL = 'claude-haiku-5-5';

const TIMEOUT_S = 30;
const NO_RELAY = 'fleetherd-probe: no relay';

/**
 * Run with the agent's environment. The key reaches curl as config on stdin (`-K -`) from the
 * builtin `printf`, so it is in no process's argv and in no log: the script text holds only names.
 */
export const CLAUDE_PROBE_SCRIPT = `base="\${ANTHROPIC_BASE_URL%/}"
[ -n "$base" ] || { echo '${NO_RELAY}'; exit 0; }
model="\${ANTHROPIC_DEFAULT_HAIKU_MODEL:-${CLAUDE_PROBE_MODEL}}"
case "$model" in *[!A-Za-z0-9._:@/-]*) echo "unusable model name" >&2; exit 2;; esac
if [ -n "$ANTHROPIC_API_KEY" ]; then auth="x-api-key: $ANTHROPIC_API_KEY"
elif [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then auth="authorization: Bearer $ANTHROPIC_AUTH_TOKEN"
else echo "no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN" >&2; exit 2; fi
printf 'header = "%s"\\n' "$auth" | curl -sS -o /dev/null -D - --max-time ${TIMEOUT_S} -K - \\
  -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \\
  --data-binary "{\\"model\\":\\"$model\\",\\"max_tokens\\":1,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hello\\"}]}" \\
  "$base/v1/messages"`;

/**
 * What the script printed — curl's `-D -`, whose last block is the answer (a proxy's `CONNECT` or a
 * `100 Continue` comes first). Only a 200 counts; anything else is a failure, never a reading.
 */
export function parseClaudeProbe(output: string): QuotaReading {
  if (output.includes(NO_RELAY)) return { ok: false, final: true, reason: 'no ANTHROPIC_BASE_URL: not behind a relay' };
  const blocks = output.split(/\r?\n(?=HTTP\/)/);
  const [statusLine = '', ...lines] = (blocks[blocks.length - 1] ?? '').split(/\r?\n/);
  const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine)?.[1];
  if (!status) return { ok: false, reason: `probe got no HTTP response (${output.trim().slice(0, 80) || 'nothing'})` };
  if (status !== '200') return { ok: false, reason: `probe answered HTTP ${status}` };
  const headers = new Map<string, string>();
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  const pools = claudeHeaderPools((name) => headers.get(name));
  return pools.length
    ? { ok: true, pools }
    : { ok: false, final: true, reason: 'the relay answered without anthropic-ratelimit-unified-* headers' };
}

/**
 * The probe where the agent runs: here with `bash -c` and the environment the agent was started
 * with, or on its host through fleetherd-remote, as a `quotaCommand` is. Never throws.
 */
export async function readClaudeQuota(def: AgentDef, cwd: string): Promise<QuotaReading> {
  const timeoutMs = (TIMEOUT_S + 15) * 1000;
  try {
    const host = remoteHosts.hostFor(def);
    if (!host) {
      if (process.platform === 'win32') return { ok: false, final: true, reason: 'the quota probe needs bash and curl' };
      const { stdout } = await execFile('bash', ['-c', CLAUDE_PROBE_SCRIPT], { cwd, env: buildHarnessEnv(def), timeout: timeoutMs, maxBuffer: 1 << 16 });
      return parseClaudeProbe(stdout);
    }
    const r = await host.run({ bash: CLAUDE_PROBE_SCRIPT, cwd, env: remoteAgentEnv(def), timeoutMs, max: 1 << 16 });
    if (r.spawnError || r.timedOut || r.code !== 0) {
      const why = r.spawnError ?? (r.timedOut ? 'timed out' : `exited ${r.code ?? r.signal}`);
      return { ok: false, reason: `quota probe on ${host.id} ${why}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}` };
    }
    return parseClaudeProbe(r.output.toString('utf8'));
  } catch (e) {
    const err = e as { stderr?: unknown; message?: unknown };
    const said = typeof err.stderr === 'string' && err.stderr.trim() ? err.stderr.trim() : String(err.message ?? e);
    return { ok: false, reason: `quota probe: ${said.slice(0, 200)}` };
  }
}

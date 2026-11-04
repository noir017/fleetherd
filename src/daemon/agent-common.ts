import { homedir } from 'node:os';
import { join, posix, resolve, delimiter } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import type { AgentStreamHandlers } from './agent.js';
import { remoteHosts } from './remote-hosts.js';
import { placeInstructions } from './instructions.js';
import { ensureReverseCliShim } from './reverse-cli-shim.js';
import { ensureSkillLink } from './skill-link.js';

/**
 * Helpers shared by every agent-runtime implementation (agent-acp.ts, agent-agy.ts).
 *
 * These were originally private to agent-acp.ts; they moved here when the agy harness arrived,
 * because agy does NOT speak ACP (it has its own bidirectional stream-json protocol) and therefore
 * needs a sibling runtime rather than another `resolveHarness` arm. Everything in this file is
 * protocol-agnostic: process environment, working directory, tool-preview formatting and child
 * termination — i.e. the parts both runtimes must behave identically on.
 */

/** Grace window after SIGTERM; if still alive, SIGKILL fallback (harness CLIs may ignore SIGTERM mid-turn). */
export const KILL_GRACE_MS = 2_000;

/** Expand ${VAR} to its process.env value (missing → empty string, with one warn for diagnosis). */
export function expandEnv(v: string): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const val = process.env[name];
    if (val === undefined) {
      console.warn(`[agent] env expansion: variable \${${name}} is undefined, treating as empty string (check the daemon launch environment)`);
      return '';
    }
    return val;
  });
}

/** Expand a leading ~ to the home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve an agent's working directory (the cwd the agent runtime is launched in).
 *
 * - Explicit config `cwd`: used as-is (after ~ expansion) — the project you want the agent to act on;
 *   not auto-created (a missing dir likely means a typo, better surfaced than silently masked).
 * - Unset: each agent gets an isolated, auto-created workspace at ~/.talkcode/agents/<id>. This keeps an
 *   unconfigured agent out of talkcode's own source tree (the previous fallback) and gives it a clean,
 *   per-agent home that's stable across this agent's sessions.
 */
export function resolveAgentCwd(def: AgentDef): string {
  // On a remote host the directory is that host's, and is not made here: the spawn makes it there
  // (prepareRemoteSpawn). Until the host has been reached once, a `~` in it stays a `~`.
  const host = remoteHosts.hostFor(def);
  if (host) return remoteAgentRoot(def, host.conn.welcome?.home);
  if (def.cwd) return resolve(expandHome(def.cwd));
  const dir = join(homedir(), '.talkcode', 'agents', def.id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The directory THIS conversation's next session starts in: its `/cd` choice, or the agent's
 * configured cwd when it has made none.
 *
 * Called at spawn time by both runtimes rather than once per session object, because that is the
 * only moment the answer can still change anything — ACP fixes the directory at `session/new` and
 * agy at process spawn, so a session already running is standing where it is until it is replaced.
 * Reading it late is what lets `/cd` take effect by disposing the child instead of by mutating a
 * closure nobody re-reads.
 *
 * A recorded directory that has since disappeared falls back to the root rather than failing the
 * turn: the conversation is still answerable from the agent's own workspace, and a spawn that dies
 * on a missing cwd would strand it with an error the user cannot act on from a phone.
 */
export function resolveConversationCwd(
  def: AgentDef,
  conversationId: string,
  store?: { conversationCwd(key: string): string | undefined }
): string {
  const root = resolveAgentCwd(def);
  const chosen = store?.conversationCwd(conversationId);
  if (!chosen || chosen === root) return root;
  // A remote directory cannot be checked synchronously from here; prepareRemoteSpawn checks it on
  // the host, with the same fallback to the root.
  if (def.host) return chosen;
  try {
    if (statSync(chosen).isDirectory()) return chosen;
    console.warn(`[agent] recorded working dir "${chosen}" is not a directory; using ${root}`);
  } catch {
    console.warn(`[agent] recorded working dir "${chosen}" is gone; using ${root}`);
  }
  return root;
}

/**
 * The part of an agent child's environment that has nothing to do with a session: the daemon's own
 * environment, cleaned of the launcher's Claude Code markers, plus the agent's expanded `env` block.
 *
 * Split out from buildAgentEnv because the gateway also runs harness CLIs that are NOT sessions —
 * agy's own slash commands, each answered by a one-shot process (daemon/agent-agy.ts). Those need
 * the agent's identity (a `HOME` override decides which account's config the CLI reads) and must
 * NOT get the reverse-command wiring: there is no turn to call back into, and a token in the
 * environment of a process that cannot use it is a secret spent for nothing.
 */
export function buildHarnessEnv(def: AgentDef): Record<string, string | undefined> {
  // spawn replaces the environment by default, so merge process.env explicitly.
  const env: Record<string, string | undefined> = { ...process.env };
  // Strip the launcher's Claude Code session markers: otherwise, if the daemon itself was launched
  // inside a Claude Code session, the child inherits CLAUDECODE/CLAUDE_CODE_* and the underlying Claude
  // CLI refuses with "Claude Code cannot be launched inside another Claude Code session".
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE') && k !== 'CLAUDE_CODE_EXECUTABLE') delete env[k];
  }
  for (const [k, v] of Object.entries(def.env)) env[k] = expandEnv(v);
  return env;
}

/**
 * Build the environment for an agent child process: merged process.env + expanded def.env +
 * the per-session reverse-command wiring.
 *
 * Shared verbatim by both runtimes so the reverse CLI (`talkcode …`) behaves the same
 * regardless of which harness is running. Called at every spawn, which also makes it the one place
 * both runtimes provision what that CLI depends on: the shim on PATH, and the skill that names it.
 */
export function buildAgentEnv(
  def: AgentDef,
  sessionToken: string,
  socketPath: string
): Record<string, string | undefined> {
  const env = buildHarnessEnv(def);
  env.TALKCODE_TURN_TOKEN = sessionToken;
  env.TALKCODE_SOCKET = socketPath;
  // Guarantee the reverse CLI the skill promises: prepend the self-provisioned shim dir so
  // `talkcode` resolves to THIS daemon's own entry regardless of launch mode (see reverse-cli-shim).
  const shimDir = ensureReverseCliShim();
  if (shimDir) env.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`;
  // The skill goes under the home THIS agent runs as — an `env.HOME` override included — because
  // that is where its harness will look (see skill-link). The operator's instructions likewise.
  ensureSkillLink(def.harness, env.HOME || homedir(), def.command);
  placeInstructions(def, env.HOME || homedir());
  return env;
}

/**
 * What the runtimes need of an agent's process — met by a local child_process and by a process on
 * a remote host (remote/host.ts RemoteChild) alike, so neither runtime has to know which it holds.
 */
export interface AgentChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

// ───────────────────────── agents on a remote host ─────────────────────────

/** `~` and `~/…` resolved against a remote host's home (POSIX paths: hosts are Linux). */
export function expandRemoteHome(p: string, home: string | undefined): string {
  if (!home) return p;
  if (p === '~') return home;
  return p.startsWith('~/') ? posix.join(home, p.slice(2)) : p;
}

/** A remote agent's own directory: its `cwd`, or a workspace of its own like a local agent gets. */
export function remoteAgentRoot(def: AgentDef, home: string | undefined): string {
  return expandRemoteHome(def.cwd ?? `~/.talkcode/agents/${def.id}`, home);
}

/** The home a remote agent runs as: an `env.HOME` override, else the account's own. */
export function remoteAgentHome(def: AgentDef, w: Welcome): string {
  const override = def.env['HOME'];
  return override ? expandRemoteHome(expandEnv(override), w.home) : w.home;
}

/**
 * A remote agent's environment, as an overlay: its `env` block and, for a session, the turn token
 * its `talkcode` command identifies itself with. The rest is the HOST's login environment
 * (remote/shellenv.go) — never this daemon's, which describes the wrong machine.
 */
export function remoteAgentEnv(def: AgentDef, sessionToken?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.env)) env[k] = expandEnv(v);
  if (sessionToken) env.TALKCODE_TURN_TOKEN = sessionToken;
  return env;
}

/**
 * Everything a remote spawn needs before the process can start: the host reached (or the reason it
 * cannot be), the directory resolved and present on it, and the bundled skill and the operator's
 * instructions placed for the harness. Mirrors what the local path does — an agent's own workspace is created, a configured
 * directory is not (a typo should say so), and a `/cd` choice that has since disappeared falls back
 * to the root rather than failing the turn.
 */
export async function prepareRemoteSpawn(
  def: AgentDef,
  host: RemoteHost,
  cwd: string
): Promise<{ welcome: Welcome; cwd: string }> {
  const welcome = await host.ready();
  const root = remoteAgentRoot(def, welcome.home);
  let dir = expandRemoteHome(cwd, welcome.home);
  if (dir !== root) {
    const st = await host.stat(dir);
    if (!st.exists || !st.dir) {
      console.warn(`[agent] recorded working dir "${dir}" is gone on ${host.id}; using ${root}`);
      dir = root;
    }
  }
  if (dir === root) {
    if (def.cwd === undefined) await host.mkdirp(root);
    else {
      const st = await host.stat(root);
      if (!st.exists || !st.dir) throw new Error(`agent "${def.id}": working directory ${root} does not exist on host "${host.id}"`);
    }
  }
  await remoteHosts.placeSkill(host, def, remoteAgentHome(def, welcome), welcome);
  await remoteHosts.placeInstructions(host, def, remoteAgentHome(def, welcome), welcome);
  return { welcome, cwd: dir };
}

/** How long a lost connection is waited out before the chat is told about it. */
const LINK_NOTICE_AFTER_MS = 10_000;

/**
 * For one turn of an agent on a remote host: tell the chat when the connection to the host is lost
 * for longer than a blip, and when it is back — the agent keeps working through it (remote/README.md),
 * so silence would otherwise read as a hang. `onUp` lets the runtime restart its silence watchdog,
 * which must not count the outage against the agent. Returns the disposer; a no-op for a local agent.
 */
export function watchRemoteLink(
  host: RemoteHost | undefined,
  handlers: Pick<AgentStreamHandlers, 'onNotice'>,
  onUp: () => void
): () => void {
  if (!host) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let told = false;
  const down = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      told = true;
      handlers.onNotice?.(`⚠️ Lost the connection to ${host.id}. The agent keeps working there; its reply follows once the connection is back.`);
    }, LINK_NOTICE_AFTER_MS);
    timer.unref?.();
  };
  const up = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (told) handlers.onNotice?.(`✅ Reconnected to ${host.id}.`);
    told = false;
    onUp();
  };
  host.on('down', down);
  host.on('up', up);
  if (!host.isUp && host.conn.welcome) down();
  return () => {
    host.off('down', down);
    host.off('up', up);
    if (timer) clearTimeout(timer);
  };
}

/**
 * Terminate a child process: SIGTERM, then a delayed SIGKILL fallback if it ignored it.
 * Best-effort and non-blocking; a process that already exited is left alone (killing a reaped
 * pid could hit a pid-reused stranger).
 */
export function killChildProcess(child: AgentChild, graceMs = KILL_GRACE_MS): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Considered detached+kill(-pid) to kill the whole group, but detached changes
  // stdio/process-group semantics and children would survive a daemon crash — risk over reward.
  child.kill(); // SIGTERM
  const grace = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL'); // fallback: the harness may not exit on SIGTERM
      } catch (e) {
        console.debug('[agent] SIGKILL fallback failed:', e instanceof Error ? e.message : e);
      }
    }
  }, graceMs);
  grace.unref?.(); // don't let the fallback timer hold up process exit
}

/**
 * Keys probed (in order) for a one-line tool-argument preview. Both naming conventions are listed
 * because the harnesses disagree: ACP agents (claude/codex/opencode) use snake_case
 * (`command`, `file_path`), while agy's tools use PascalCase (`CommandLine`, `AbsolutePath`,
 * `Query` + `SearchPath`). Meaningful keys come first so incidental ones agy also sends
 * (`Cwd`, `WaitMsBeforeAsync`, `toolAction`) never win the preview.
 */
const PREVIEW_KEYS = [
  // snake_case (ACP harnesses)
  'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt',
  // PascalCase (agy)
  'CommandLine', 'AbsolutePath', 'DirectoryPath', 'Query', 'SearchPath', 'TargetFile', 'Url',
];

/**
 * Short summary of a tool's raw input (ToolRenderer still truncates per previewLimit); empty object → "" (don't show "{}").
 *
 * A parameter the harness is still streaming also reads as "" rather than as JSON. CodeBuddy Code
 * sends `{command: ""}` a frame before `{command: "echo hi"}`, and a preview of `{"command":""}` in
 * between is worse than none: it is the row the reader sees first, and it says nothing. The key
 * being there is what distinguishes "not streamed yet" from a shape this function does not know,
 * which still falls back to the JSON dump.
 */
export function buildInputPreview(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return '';
    let streaming = false;
    for (const key of PREVIEW_KEYS) {
      const v = obj[key];
      if (typeof v !== 'string') continue;
      if (v.length > 0) return v;
      streaming = true;
    }
    if (streaming) return '';
    try {
      return JSON.stringify(obj);
    } catch {
      return '';
    }
  }
  return typeof input === 'string' ? input : '';
}

/**
 * How much of a harness's reason reaches the chat.
 *
 * turn-runner caps the whole failure message at 300 characters, and the timeout sentence already
 * spends ~85 of them; a long reason (opencode's connection errors run past 200) would push the cap
 * over and truncate the message from the RIGHT, cutting the reason's own tail off anyway. Trimming
 * here instead keeps the sentence intact and loses only the far end of a long reason.
 */
const REASON_MAX_CHARS = 150;

/** A harness's reason, flattened to one line and trimmed to fit (see REASON_MAX_CHARS). */
export function trimReason(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim();
  return flat.length > REASON_MAX_CHARS ? `${flat.slice(0, REASON_MAX_CHARS - 1)}…` : flat;
}

/** Non-empty-object check (whether raw input already carries params). */
export function isNonEmptyObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && Object.keys(v as object).length > 0;
}

/** Strip markdown code backticks (claude-code-acp wraps command titles as `cmd`). */
export function stripCode(s?: string): string {
  return (s ?? '').replace(/`/g, '').trim();
}

/** Truncate a tool display name to keep bubbles in the `emoji shortname: "args"` style. */
export function truncateToolName(s: string, max = 32): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

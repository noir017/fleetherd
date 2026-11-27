import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentDef } from '../config/schema.js';
import type { RemoteHost } from '../remote/host.js';
import { agentHome } from './harness/profile.js';
import { remoteAgentHome } from './agent-common.js';
import { remoteHosts } from './remote-hosts.js';

/** The harness ids, taken from the config shape rather than re-declared (as skills-scan does). */
type Harness = AgentDef['harness'];

/**
 * What a harness wrote in its OWN log about a turn the gateway cannot see into.
 *
 * ── Why this file has to exist ────────────────────────────────────────────────────────────────────
 * The silence watchdog can tell that a turn went quiet; it cannot tell why, and the difference
 * matters to the person waiting. Reported 2026-09-17: every `oc` turn sat at "typing" for ten
 * minutes and then failed with `agent "oc" sent no update for 600000ms; treating it as hung`. The
 * agent was not hung at all — opencode's free model pool was rate-limiting it, and opencode was
 * retrying in a loop.
 *
 * None of that reaches the gateway. Verified on opencode 1.18.30 (2026-09-17) while reproducing the
 * report: over ACP the prompt neither settles nor rejects, nothing is written to the child's stderr
 * (which agent-acp.ts already forwards to the daemon log — `grep -c "Rate limit" daemon.log` → 0),
 * and the only record anywhere on the machine is opencode's own log file:
 *
 *   timestamp=2026-09-17T12:23:38.570Z level=ERROR run=fc674adf message="stream error"
 *     providerID=opencode modelID=muse-spark-1.3-contributor-free
 *     session.id=ses_f50ad7853ffe6X1R7a1EXaR7CF small=false agent=build mode=primary
 *     error.error="AI_APICallError: Rate limit exceeded. Please try again later."
 *
 * That `session.id` is the same id the daemon holds as its ACP session, which is what makes this
 * worth doing: the errors of ONE conversation can be picked out of a log shared by all of them.
 *
 * ⚠️ HYRUM'S LAW: a log file is not an API. opencode documents neither this path nor this line
 * format, and is free to change both in any release. Everything here is therefore built to degrade
 * to silence — a moved file, a renamed field or an unparsable line yields no events, which puts the
 * timeout message back to exactly the text it had before this file existed. It never throws into a
 * turn, and it is never consulted on the happy path.
 *
 * ── Why per-harness rather than one parser ────────────────────────────────────────────────────────
 * Because the answer "where does this harness admit its failures" is different for each one, and
 * only opencode currently needs asking: claude-agent-acp rejects the prompt with its reason (the
 * `[ede_diagnostic]` failures in daemon.log arrived this way and were already actionable), and agy
 * speaks no ACP at all. The registry keeps that per-harness knowledge in one place so the next
 * harness that goes silent is a table entry, not a new seam.
 */

/** One error a harness logged against a session. */
export interface HarnessLogEvent {
  /** When the harness recorded it, used to keep this turn's errors and drop older ones. */
  at: Date;
  /** The reason, already unquoted and trimmed — safe to put straight into a chat message. */
  reason: string;
}

/** How to ask one harness what went wrong. */
export interface HarnessLogProbe {
  /** Where this harness writes the log, given the agent's home and the daemon's environment. */
  logPath(home: string, env: NodeJS.ProcessEnv): string;
  /**
   * The events for `sessionId` recorded at or after `since`.
   *
   * Pure, so the per-harness log format is testable without a filesystem — the same split
   * `skills-scan.ts` makes between `skillDirsFor` and the scan around it.
   */
  parse(tail: string, sessionId: string, since: Date): HarnessLogEvent[];
}

/**
 * How much of the tail to read.
 *
 * The live log on this machine is already 3.3 MB and only grows, so reading it whole to answer one
 * timeout is out of the question. 256 KiB is far more than one turn's worth of lines while staying
 * cheap enough to also run on the in-turn poll.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * opencode's log line, as captured above: space-separated `key=value`, values quoted when they
 * contain spaces, with `"` inside a quoted value backslash-escaped.
 *
 * Anchored on the three fields that carry the answer and tolerant of everything else, because field
 * ORDER is the part most likely to drift: each is matched independently rather than as one line
 * pattern. A line missing any of them is simply not an event.
 */
const OC_TIMESTAMP = /(?:^|\s)timestamp=(\S+)/;
const OC_SESSION = /(?:^|\s)session\.id=(\S+)/;
const OC_ERROR = /(?:^|\s)error\.error="((?:[^"\\]|\\.)*)"/;
/**
 * opencode's own auxiliary calls (it titles a session with a second, smaller model) carry
 * `small=true`. They are excluded: a failed title is not a failed turn, and during the rate-limit
 * incident it doubled every notice. Absence of the field means "not an auxiliary call" so that a
 * future opencode dropping it degrades to reporting everything rather than nothing.
 */
const OC_SMALL = /(?:^|\s)small=true(?:\s|$)/;

/** Undo the backslash escaping inside a quoted value (`\"` → `"`, `\\` → `\`). */
function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Pull one session's errors out of a chunk of opencode's log.
 *
 * Exported for its tests, which drive it with lines captured verbatim from the live log.
 */
export function parseOpencodeLog(tail: string, sessionId: string, since: Date): HarnessLogEvent[] {
  const events: HarnessLogEvent[] = [];
  const lines = tail.split('\n');
  // The first line of a tail read starts mid-line whenever the file is larger than the window, so
  // it is dropped: a half line cannot be parsed, and guessing at one risks a truncated reason.
  for (const line of lines.slice(1)) {
    if (!line.includes('level=ERROR')) continue;
    if (OC_SMALL.test(line)) continue;
    if (OC_SESSION.exec(line)?.[1] !== sessionId) continue;
    const stamp = OC_TIMESTAMP.exec(line)?.[1];
    const reason = OC_ERROR.exec(line)?.[1];
    if (!stamp || !reason) continue;
    const at = new Date(stamp);
    if (Number.isNaN(at.getTime()) || at.getTime() < since.getTime()) continue;
    const text = unescape(reason).trim();
    if (text.length > 0) events.push({ at, reason: text });
  }
  return events;
}

const PROBES: Partial<Record<Harness, HarnessLogProbe>> = {
  opencode: {
    // opencode's data directory, by its own XDG resolution as observed on this machine
    // (`XDG_DATA_HOME` unset here, so `~/.local/share`). One file, no rotation seen.
    logPath: (home, env) => join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), 'opencode', 'log', 'opencode.log'),
    parse: parseOpencodeLog,
  },
};

/** Whether this harness keeps a log worth asking, i.e. whether the in-turn poll should run at all. */
export function harnessLogProbe(harness: Harness): HarnessLogProbe | undefined {
  return PROBES[harness];
}

/**
 * The last `TAIL_BYTES` of a file as text, or nothing at all.
 *
 * Absence is the ordinary case (the harness was never run on this machine), so it is not logged;
 * every other failure is swallowed too, because this only ever runs while a turn is already in
 * trouble and must not add a second one.
 */
async function readTail(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The same tail from an agent's remote host, filtered there to the lines a parser could use: a
 * stretch of a log is mostly not errors, and this runs on a poll. The host already dropped the line
 * its window cut in half, so a blank one is put in front for the parser to drop instead. Environment
 * overrides (XDG_DATA_HOME) come from the agent's own `env` only — this daemon's describe the wrong
 * machine.
 */
async function readRemoteTail(host: RemoteHost, def: AgentDef, probe: HarnessLogProbe): Promise<string | undefined> {
  const w = host.conn.welcome;
  if (!w || !host.isUp) return undefined;
  try {
    const path = probe.logPath(remoteAgentHome(def, w), def.env);
    return `\n${await host.readTail(path, TAIL_BYTES, { grep: ['level=ERROR'], timeoutMs: 10_000 })}`;
  } catch {
    return undefined;
  }
}

/**
 * What `def`'s harness logged against `sessionId` since `since`, oldest first.
 *
 * Empty whenever anything is missing — an unsupported harness, no session id yet, no log file, a
 * format that no longer parses. Callers treat "nothing to say" and "nothing went wrong" the same,
 * which is what keeps a broken probe from inventing a reason for a turn that failed differently.
 */
export async function readHarnessErrors(
  def: AgentDef,
  sessionId: string | undefined,
  since: Date,
  env: NodeJS.ProcessEnv = process.env
): Promise<HarnessLogEvent[]> {
  const probe = harnessLogProbe(def.harness);
  if (!probe || !sessionId) return [];
  const host = remoteHosts.hostFor(def);
  const tail = host ? await readRemoteTail(host, def, probe) : await readTail(probe.logPath(agentHome(def), env));
  if (tail === undefined) return [];
  try {
    return probe.parse(tail, sessionId, since);
  } catch (e) {
    // A parser that throws on a line shape nobody predicted must not take the turn's own error
    // message down with it; the turn still reports the timeout, just without the harness's reason.
    console.warn(`[harness-log] could not parse ${def.harness}'s log:`, e instanceof Error ? e.message : e);
    return [];
  }
}

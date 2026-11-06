import path from 'node:path';

import type { AgentDef } from '../config/schema.js';
import { remoteAgentHome } from './agent-common.js';
import { readTailLines } from './claude-transcript.js';
import { remoteHosts } from './remote-hosts.js';
import { agentHome } from './skills-scan.js';

/**
 * agy's context, read off the session's own transcript — for the turns whose ACP usage cannot say.
 *
 * ── Why the transcript ────────────────────────────────────────────────────────
 * `agy acp` reports usage once per turn, in the `session/prompt` response, summed over every model
 * call the turn made (agy-acp.ts contextTokensOf). That is the context only for a turn of one call;
 * a turn that ran a tool made several, and almost every turn an agent works through runs one. From
 * 2.40.0 to here such a turn therefore showed no context at all — in the footer, the status strip
 * and `talkcode tasks` — which for agy was nearly always.
 *
 * agy's hooks do not carry tokens (`SessionStart`, `Pre/PostToolUse`, `Pre/PostInvocation`, `Stop`:
 * conversation id, workspace, model, `transcriptPath` — agy's bundled
 * `agy-customizations/docs/hooks.md`), but the file `transcriptPath` names does. Measured on agy
 * 1.5.2 (2026-11-06, `project-scripts/talkcode-agy-context/`):
 *
 *   <home>/.gemini/antigravity-cli/brain/<session id>/.system_generated/logs/transcript.jsonl
 *
 *   {"step_index":102,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
 *    "created_at":"2026-11-06T15:56:34Z","input_tokens":2570,"cache_read_tokens":94591,
 *    "output_tokens":124,"tool_calls":[…]}
 *
 * One `PLANNER_RESPONSE` line per model call, written as the call completes, so mid-turn too. Its
 * numbers matched the per-call rows agy keeps in its own SQLite store
 * (`conversations/<session id>.db`, table `gen_metadata`) one for one across a 50-call session, and
 * the ACP session id IS the directory name (checked against the four agy topics running then). Like
 * the prompt response, `input_tokens` leaves the cached part out, so the context is the two added.
 * agy cuts long fields in this file (`truncated_fields`; the whole text is in transcript_full.jsonl),
 * which keeps its lines under ~4.5 KB — TAIL_BYTES holds the last fifty calls or so.
 *
 * ⚠️ HYRUM'S LAW: this is agy's private on-disk format, not an interface. The day the path or the
 * fields change, a read finds nothing and agy's context goes back to showing only after a turn that
 * ran no tool — nothing wrong is shown. agy-transcript.test.ts pins the shape with captured lines.
 */

const TAIL_BYTES = 256 * 1024;

/**
 * How often a running turn re-reads the transcript. A tool-heavy agy turn ends a model call every few
 * seconds, and each read is a file tail or one request over a host's link; a context figure on a
 * status strip does not need to be fresher than this.
 */
export const AGY_CONTEXT_REFRESH_MS = 10_000;

/** What a remote read asks the host to keep of each line: the rest is the model's text and tool calls. */
const FIELDS = ['type', 'input_tokens', 'cache_read_tokens'];

/** The line marker of a model call, matched on the host before any JSON is parsed. */
const MODEL_CALL = '"type":"PLANNER_RESPONSE"';

/**
 * Remote reads give up quickly: one runs at every turn's end and the footer waits for it. A link
 * that slow is down in all but name, and the context can wait for the next turn.
 */
const REMOTE_TIMEOUT_MS = 3_000;

/** Session ids come from this daemon's own store, but one becomes part of a path: refuse anything not id-shaped. */
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The transcript of one session under an agy home. */
export function agyTranscriptPath(home: string, sessionId: string, join: (...p: string[]) => string = path.join): string {
  return join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

/**
 * Tokens in context as of the last model call in these transcript lines (file order): its input plus
 * its cache reads. Undefined when no line is a model call with a usable count — a fresh session, or
 * a format this no longer understands.
 */
export function agyContextFromLines(lines: string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('PLANNER_RESPONSE')) continue;
    let entry: { type?: unknown; input_tokens?: unknown; cache_read_tokens?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'PLANNER_RESPONSE' || !count(entry.input_tokens)) continue;
    return (entry.input_tokens as number) + (count(entry.cache_read_tokens) ? (entry.cache_read_tokens as number) : 0);
  }
  return undefined;
}

function count(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * The context of one agy session, from its transcript on whichever machine the agent runs. Never
 * rejects: an unreadable transcript is the documented way for this to stop working (above), and it
 * must cost a footer segment, not a turn.
 */
export async function readAgyContext(def: AgentDef, sessionId: string): Promise<number | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const host = remoteHosts.hostFor(def);
  try {
    if (host) {
      const w = host.conn.welcome;
      if (!w || !host.isUp) return undefined;
      const file = agyTranscriptPath(remoteAgentHome(def, w), sessionId, path.posix.join);
      const tail = await host.readTail(file, TAIL_BYTES, { grep: [MODEL_CALL], fields: FIELDS, timeoutMs: REMOTE_TIMEOUT_MS });
      return agyContextFromLines(tail.split('\n'));
    }
    return agyContextFromLines(await readTailLines(agyTranscriptPath(agentHome(def), sessionId), TAIL_BYTES));
  } catch (e) {
    console.debug(`[acp] could not read agy's transcript for ${sessionId}:`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

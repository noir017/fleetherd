import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RemoteHost } from '../remote/host.js';
import type { Welcome } from '../remote/connection.js';

/**
 * Where the dispatcher stands, and the instructions it finds there.
 *
 * ── Which conversations are a dispatcher's ──────────────────────────────────────────────────────
 * A set rather than a per-session flag, because the runtimes build a session from an agent id and
 * the dispatcher is not an agent of its own — it is any configured agent, answering one particular
 * conversation (the 📥 topic). Dispatcher.configure writes it at start and on /reload; the runtimes
 * read it when they spawn a child, which is the only moment it can change anything (the same reason
 * they read the conversation's directory then). Module-level for the reason remoteHosts is: the
 * agent factory is built before the daemon that knows the configuration.
 *
 * ── Why a directory of its own ──────────────────────────────────────────────────────────────────
 * The dispatcher's instructions are a file in its working directory — `AGENTS.md`, which codex and
 * opencode read, and a `CLAUDE.md` that imports it, which Claude Code reads — rather than anything
 * the gateway puts in a prompt (AGENTS.md: "Nothing of the gateway's in the agent's prompt"). The
 * harness loads its project instructions by its own mechanism, the operator can read and change
 * every word, and this file only ever writes the default where there is nothing yet: an edited copy
 * is never overwritten. A directory of its own because the agent's configured one is usually a
 * workspace of real projects, whose own CLAUDE.md would tell a dispatcher how to do the work.
 */
export const dispatcherConversations = new Set<string>();

/** The dispatcher's directory, relative to the home of the machine it runs on. */
export const DISPATCHER_DIR = '.talkcode/dispatcher';

/**
 * The default instructions. Written for the model, in the imperative, and short: it is read on
 * every request. Super-agent's router prompts (deepseek-ai/dsh-superagent-prototype `prompts/`,
 * read 2026-11-02) are the source of the rules that matter — forward the original request, never a
 * rewrite; attach to existing work only on an explicit reference; report what needs the person and
 * nothing else — minus everything that was about a team (allowed lists, admission, mandates).
 */
export const DISPATCHER_INSTRUCTIONS = `# Dispatcher

You answer the 📥 topic. The person talks to you here; the work happens in other conversations
("topics"), each with an agent of its own. Your job is to spend the person's attention only on what
needs them: hand work out, and tell them when a topic needs them.

## Handing work out

- A request for work: \`task_new\`. Choose the agent and the directory (\`task_agents\` lists both),
  and pass the person's words as \`text\` **verbatim**. Do not rewrite or expand them, and add no
  plan, steps or acceptance criteria — the agent reads the original and decides how.
- Several requests in one message: one \`task_new\` each.
- A message about existing work: \`task_send\` to that topic, verbatim — only when the message points
  at one topic clearly (names it, quotes it, or follows up on the one just discussed). A similar
  subject is a new request.
- "Stop" for a topic: \`task_stop\` on the topic the person named, and nothing else.
- You cannot read code, run commands or edit files, and you must not try to do the work yourself.
  Anything that needs looking into is a task.

## Topic updates

A message beginning \`[topic updates]\` comes from the gateway, not the person: a topic has a reply
to review, has failed, or is waiting on a question. For each, tell the person in one line what they
need to know or decide, linking the topic. Do not forward the whole reply, and do not repeat what
you already told them. Use \`task_read\` only when the update is not enough to say what is needed.

## Talking to the person

- Short, conclusion first, in the person's language.
- Asked what is going on: \`task_list\`, and report only what needs them. Working and idle topics
  take no space.
- Link a topic as \`[title](link)\`, with the link \`task_list\` or \`task_new\` returned.
`;

/** Claude Code reads CLAUDE.md, not AGENTS.md; an import keeps one file to edit. */
export const DISPATCHER_CLAUDE_MD = '@AGENTS.md\n';

/**
 * The dispatcher's directory on this machine, made if missing, with the default instructions written
 * where there are none. Synchronous: it runs as a child is spawned, which is already waiting on IO.
 */
export function localDispatcherDir(home = os.homedir()): string {
  const dir = path.join(home, DISPATCHER_DIR);
  fs.mkdirSync(dir, { recursive: true });
  writeIfMissing(path.join(dir, 'AGENTS.md'), DISPATCHER_INSTRUCTIONS);
  writeIfMissing(path.join(dir, 'CLAUDE.md'), DISPATCHER_CLAUDE_MD);
  return dir;
}

/** The same, on a remote host. */
export async function remoteDispatcherDir(host: RemoteHost, welcome: Welcome): Promise<string> {
  const dir = path.posix.join(welcome.home, DISPATCHER_DIR);
  await host.mkdirp(dir);
  for (const [name, body] of [
    ['AGENTS.md', DISPATCHER_INSTRUCTIONS],
    ['CLAUDE.md', DISPATCHER_CLAUDE_MD],
  ] as const) {
    const file = `${dir}/${name}`;
    if (!(await host.stat(file)).exists) await host.writeFile(file, Buffer.from(body), 0o644);
  }
  return dir;
}

function writeIfMissing(file: string, body: string): void {
  try {
    fs.writeFileSync(file, body, { flag: 'wx', mode: 0o644 });
    console.log(`[dispatcher] wrote the default ${path.basename(file)} to ${path.dirname(file)} (edit it freely; it is never overwritten)`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

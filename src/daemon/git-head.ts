import type { Workspace } from './workspace.js';

/** The commit a working directory is on, and its branch when it is on one. */
export interface GitHead {
  sha: string;
  /** Absent on a detached HEAD, where git answers the literal `HEAD`. */
  branch?: string;
}

/**
 * How long one read may take. The review loop reads before a reviewer is started, and a host over
 * ssh answers in well under a second; ten is the margin for one that is busy, not a budget anyone
 * waits on routinely.
 */
const HEAD_TIMEOUT_MS = 10_000;

/**
 * The commit `ws` is on — one `git rev-parse` for both lines (`--abbrev-ref` applies to the
 * arguments after it, so `HEAD --abbrev-ref HEAD` prints the sha, then the branch).
 *
 * Undefined when there is no answer to give: not a git repository, an unborn branch, a machine that
 * did not answer in time. The review loop treats that as "cannot tell whether anything was
 * committed" and says so, rather than reviewing on a guess (delegation.ts).
 */
export async function readHead(ws: Workspace): Promise<GitHead | undefined> {
  let r;
  try {
    r = await ws.run(['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], {
      // No index refresh: a read here must never take the lock a running agent's own git needs.
      env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      timeoutMs: HEAD_TIMEOUT_MS,
      maxBytes: 4_096,
    });
  } catch {
    return undefined;
  }
  if (r.code !== 0 || r.timedOut || r.spawnError) return undefined;
  const [sha, branch] = r.output.toString('utf8').trim().split('\n').map((l) => l.trim());
  if (!sha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) return undefined;
  return { sha, ...(branch && branch !== 'HEAD' ? { branch } : {}) };
}

/**
 * Waiting out the work in progress before the gateway stops.
 *
 * A SIGTERM is how a container is stopped, and so how the gateway is restarted and updated
 * (docker/fleetherd-host). Stopping at once cuts off every turn in progress — the agents on the hosts
 * go down with the gateway that started them (docs/remote-hosts.md) — so a SIGTERM that finds work
 * in progress waits for it first: the daemon stops taking new turns and new scheduled runs, lets the
 * running ones finish, and stops when none are left (Daemon.beginDrain). This file is the waiting.
 *
 * Bounded, because the turn being waited for can be an agent working for hours, and an update has
 * to land eventually. The bound is below CATCH_UP_GRACE_MS (core/schedule.ts, an hour) on purpose:
 * a scheduled run that falls due while the gateway waits is not started, and is caught up by the
 * next gateway only if it was missed by less than that.
 */

/** Longest a SIGTERM waits for the work in progress before stopping anyway. */
export const DRAIN_LIMIT_MS = 30 * 60_000;

/** How often the work in progress is counted while waiting. */
const DRAIN_POLL_MS = 1_000;

export interface InProgress {
  /** Conversations with a turn running, or a batch about to start one. */
  turns: number;
  /** Scheduled runs in flight (an agent run is also one of the turns). */
  runs: number;
}

export function nothingInProgress(p: InProgress): boolean {
  return p.turns === 0 && p.runs === 0;
}

/** "2 turns and 1 scheduled run", for the log. */
export function describeInProgress(p: InProgress): string {
  const parts: string[] = [];
  if (p.turns > 0) parts.push(`${p.turns} turn${p.turns === 1 ? '' : 's'}`);
  if (p.runs > 0) parts.push(`${p.runs} scheduled run${p.runs === 1 ? '' : 's'}`);
  return parts.join(' and ') || 'nothing';
}

/**
 * Call `done` once, when nothing is in progress any more or `limitMs` has passed, with what was still
 * in progress at that moment. Counted by polling rather than by events: a turn ends in the merger, a
 * run in the scheduler, and a second a poll costs is nothing next to a turn. Returns a cancel.
 */
export function whenIdle(
  inProgress: () => InProgress,
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
  done: (left: InProgress) => void,
  limitMs = DRAIN_LIMIT_MS
): () => void {
  const started = clock.now();
  let cancel: () => void = () => {};
  let over = false;
  const check = (): void => {
    const left = inProgress();
    if (nothingInProgress(left) || clock.now() - started >= limitMs) {
      over = true;
      done(left);
      return;
    }
    cancel = clock.schedule(check, DRAIN_POLL_MS);
  };
  check();
  return () => {
    if (over) return;
    over = true;
    cancel();
  };
}

import {
  ARCHIVE_DAYS,
  EXPIRY_DAYS,
  archiveSkill,
  listSkills,
  markExpired,
  type SkillRecord,
} from './skills-store.js';

/**
 * The daily check that keeps the managed skills from becoming a museum: after 14 days without a
 * use a skill is marked expired, after 30 it is moved into `archive/`. Pinned skills are left
 * alone, and so is every skill the gateway did not create (one with no source: a person committed
 * it to the repository or made it on the web UI's page) — nothing the gateway sees says whether a
 * hand-written skill is still read from a terminal. Nothing is ever deleted — `talkcode skills
 * restore <name>` brings an archived one back with its clock reset.
 *
 * An archive is a local commit; the skills repository's next cycle pushes it.
 *
 * "Used" is what `skill-usage.ts` counts, not a file's access time: every harness reads the start
 * of every SKILL.md when it lists them, so atime would make every skill look used every day.
 *
 * The sweep runs once when the gateway starts and then once a day. A gateway that is down for a
 * week catches up on the next start, which is the only moment it could have done anything anyway.
 */

const DAY_MS = 86_400_000;

export interface SweepResult {
  expired: string[];
  archived: SkillRecord[];
}

export type ArchiveNotice = (skill: SkillRecord, reason: 'unused' | 'manual') => void;

/** One pass, at `now`. Exposed so the tests can move the clock instead of waiting a month. */
export function sweepSkills(
  now = Date.now(),
  dir?: string,
  notify?: ArchiveNotice
): SweepResult {
  const result: SweepResult = { expired: [], archived: [] };
  for (const skill of listSkills(dir, now)) {
    // A hand-written skill (no source) and a pinned one are never expired or archived: see canExpire.
    if (skill.status === 'archived' || skill.pinned || !skill.source) continue;
    const last = Math.max(
      Date.parse(skill.lastUsedAt ?? '') || 0,
      Date.parse(skill.restoredAt ?? '') || 0,
      Date.parse(skill.createdAt) || 0
    );
    const idleDays = (now - last) / DAY_MS;
    if (idleDays >= ARCHIVE_DAYS) {
      const archived = archiveSkill(skill.name, dir, now, { kind: 'gateway' });
      result.archived.push(archived);
      notify?.(archived, 'unused');
    } else if (idleDays >= EXPIRY_DAYS && markExpired(skill.name, dir)) {
      result.expired.push(skill.name);
    }
  }
  return result;
}

/**
 * Start the daily sweep. Returns the stop function; the timer is unref'd so it never keeps the
 * process alive on its own. Callers decide whether this gateway is the one that should run it
 * (`selfInvocation` in daemon.ts, like every other write into an operator's directories).
 */
export function startSkillSweep(notify?: ArchiveNotice, dir?: string, intervalMs = DAY_MS): () => void {
  const run = (): void => {
    try {
      const swept = sweepSkills(Date.now(), dir, notify);
      for (const name of swept.expired) console.log(`[skills] ${name} has not been used for ${EXPIRY_DAYS} days; marked expired`);
      for (const skill of swept.archived) console.log(`[skills] ${skill.name} has not been used for ${ARCHIVE_DAYS} days; archived`);
    } catch (e) {
      console.warn('[skills] sweep failed:', e instanceof Error ? e.message : e);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

import type {
  SkillPanelDetail,
  SkillPanelEntry,
  SkillPanelOp,
  SkillPanelResult,
  SkillPanelSearch,
  SkillPanelSearches,
  SkillsPanel,
} from '../platform/adapter.js';
import { readQueryEvents, summarizeQueries, type SearchOutcome } from './skill-queries.js';

/** How many of each kind of search the page lists. */
const SEARCHES_SHOWN = 10;
import {
  archiveSkill,
  createSkill,
  listSkillFiles,
  listSkills,
  patchSkill,
  pinSkill,
  removeSkillFile,
  restoreSkill,
  revertSkill,
  setResident,
  showSkill,
  skillHistory,
  writeSkillFile,
  type SkillChangeBy,
  type SkillRecord,
} from './skills-store.js';
import { configDir } from '../config/load.js';

/**
 * The daemon's side of the web UI's skills page: `skills-store.ts` records → the flat shape the
 * page draws, and every operation forwarded to the store function `talkcode skills` calls.
 *
 * There is deliberately no `delete` here. The store has none — `archive` moves a skill into
 * `archive/` whole, and `restore` brings it back — so the page's "Off" switch is the archive and
 * nothing in this module can reach a hard delete even if a request asked for one.
 *
 * The one thing this adds over the store is the archive notice: `notifyArchived` is the daemon's
 * `notifySkillArchived`, the same callback the reverse command calls, so a skill archived from
 * the page tells the conversation that created it exactly as one archived from a chat does.
 * Without a source conversation that method logs instead of sending, which is why the callback is
 * allowed to be absent here (a test, or a daemon with no platforms).
 */

/** The page's view of one record. `source` stays behind: where a skill came from is the daemon's. */
function entryOf(skill: SkillRecord): SkillPanelEntry {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    status: skill.status,
    pinned: skill.pinned,
    createdAt: skill.createdAt,
    ...(skill.lastUsedAt ? { lastUsedAt: skill.lastUsedAt } : {}),
    ...(skill.restoredAt ? { restoredAt: skill.restoredAt } : {}),
    uses: skill.uses,
    agents: [...skill.agents],
    ...(skill.problem ? { problem: skill.problem } : {}),
    ...(skill.warning ? { warning: skill.warning } : {}),
    resident: skill.resident,
    ...(skill.category ? { category: skill.category } : {}),
  };
}

export interface SkillsPanelOptions {
  /** A test's temp directory; the live gateway leaves it out and uses `configDir()`. */
  dir?: string;
  /** Tell the conversation that created a skill that it was archived. */
  notifyArchived?: (skill: SkillRecord) => void;
  /**
   * Run one store write — the daemon's skills repository, which pulls before it and pushes after
   * it. Absent in a test, where the write simply runs.
   */
  write?: <T>(fn: () => T) => Promise<T>;
}

/** A change made on the page is a person's: the commit says `talkcode-web`. */
const PERSON: SkillChangeBy = { kind: 'person' };

/** Build the facade the web UI's `useSkillsPanel` seam expects. */
export function buildSkillsPanel(options: SkillsPanelOptions = {}): SkillsPanel {
  const root = (): string => options.dir ?? configDir();
  const list = (): SkillPanelEntry[] => listSkills(root()).map(entryOf);

  const detailOf = (name: string, file: string | undefined): SkillPanelDetail => {
    const shown = showSkill(name, file, root());
    const record = listSkills(root()).find((s) => s.name === shown.name);
    if (!record) throw new Error(`no skill named "${shown.name}"`);
    return {
      skill: entryOf(record),
      files: listSkillFiles(name, root()),
      file: { path: shown.file, content: shown.content, version: shown.version },
      history: skillHistory(name, root()),
    };
  };

  const done = (): SkillPanelResult => ({ ok: true, skills: list() });
  const write = async (fn: () => unknown): Promise<SkillPanelResult> => {
    await (options.write ? options.write(fn) : fn());
    return done();
  };

  return {
    list,
    searches(): SkillPanelSearches {
      const s = summarizeQueries(readQueryEvents(root()), Date.now(), SEARCHES_SHOWN);
      const view = (o: SearchOutcome): SkillPanelSearch => ({ at: o.at, query: o.query, hits: [...o.hits], ...(o.agent ? { agent: o.agent } : {}) });
      return { misses: s.misses.map(view), unread: s.unread.map(view) };
    },
    async op(request: SkillPanelOp): Promise<SkillPanelResult> {
      try {
        switch (request.action) {
          case 'show':
            return { ok: true, skills: list(), detail: detailOf(request.name, request.file) };
          case 'create':
            return await write(() =>
              createSkill({ name: request.name, description: request.description, body: request.body, by: PERSON }, root())
            );
          case 'patch':
            return await write(() =>
              patchSkill({ name: request.name, version: request.version, content: request.content, by: PERSON }, root())
            );
          case 'write-file':
            return await write(() =>
              writeSkillFile({ name: request.name, file: request.file, content: request.content, by: PERSON }, root())
            );
          case 'remove-file':
            return await write(() => removeSkillFile({ name: request.name, file: request.file, by: PERSON }, root()));
          case 'archive': {
            // `archiveSkill` is idempotent — asking twice returns the archived record without
            // moving anything — so the notice must be tied to the transition, not the call. A
            // second request from the page (or a hand-written POST) must not tell the creating
            // conversation about an archive that already happened. Read inside the write, after
            // the pull, so a skill a person archived in the repository meanwhile counts as gone.
            return await write(() => {
              const wasActive = listSkills(root()).some((s) => s.name === request.name && s.status !== 'archived');
              const archived = archiveSkill(request.name, root(), Date.now(), PERSON);
              if (wasActive) options.notifyArchived?.(archived);
            });
          }
          case 'restore':
            return await write(() => restoreSkill(request.name, root(), Date.now(), PERSON));
          case 'pin':
            pinSkill(request.name, request.pinned, root());
            return done();
          case 'resident':
            return await write(() => setResident(request.name, request.resident, root(), Date.now(), PERSON));
          case 'revert':
            return await write(() => revertSkill(request.name, request.id, root(), Date.now(), PERSON));
          default: {
            const _exhaustive: never = request;
            throw new Error(`unknown skills action: ${JSON.stringify(_exhaustive)}`);
          }
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

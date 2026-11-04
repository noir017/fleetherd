import type {
  SkillPanelDetail,
  SkillPanelEntry,
  SkillPanelOp,
  SkillPanelResult,
  SkillsPanel,
} from '../platform/adapter.js';
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
  showSkill,
  skillHistory,
  writeSkillFile,
  type SkillRecord,
} from './skills-store.js';
import { configDir } from '../config/load.js';

/**
 * The daemon's side of the web UI's skills page: `skills-store.ts` records → the flat shape the
 * page draws, and every operation forwarded to the store function `talkcode skills` calls.
 *
 * There is deliberately no `delete` here. The store has none — `archive` moves a skill into
 * `.archive/` whole, and `restore` brings it back — so the page's "Delete" is the archive and
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
  };
}

export interface SkillsPanelOptions {
  /** A test's temp directory; the live gateway leaves it out and uses `configDir()`. */
  dir?: string;
  /** Tell the conversation that created a skill that it was archived. */
  notifyArchived?: (skill: SkillRecord) => void;
}

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

  return {
    list,
    op(request: SkillPanelOp): SkillPanelResult {
      try {
        switch (request.action) {
          case 'show':
            return { ok: true, skills: list(), detail: detailOf(request.name, request.file) };
          case 'create':
            createSkill(
              {
                name: request.name,
                description: request.description,
                body: request.body,
              },
              root()
            );
            return done();
          case 'patch':
            patchSkill({ name: request.name, version: request.version, content: request.content }, root());
            return done();
          case 'write-file':
            writeSkillFile({ name: request.name, file: request.file, content: request.content }, root());
            return done();
          case 'remove-file':
            removeSkillFile({ name: request.name, file: request.file }, root());
            return done();
          case 'archive': {
            const archived = archiveSkill(request.name, root());
            options.notifyArchived?.(archived);
            return done();
          }
          case 'restore':
            restoreSkill(request.name, root());
            return done();
          case 'pin':
            pinSkill(request.name, request.pinned, root());
            return done();
          case 'revert':
            revertSkill(request.name, request.id, root());
            return done();
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

import { configDir } from '../config/load.js';
import { SkillIndex, skillBody, type SearchableSkill } from './skill-index.js';
import { missesOf, readQueryEvents, recordQueryEvent } from './skill-queries.js';
import {
  SKILL_FILE,
  activeSkillFiles,
  activeSkillStamp,
  frontmatterFields,
  listSkillFiles,
  recordSkillUse,
  showSkill,
  skillReaches,
  type SkillFileSet,
} from './skills-store.js';

/**
 * The `skills` tool's two actions — search and show — as an agent in a conversation sees them.
 *
 * What it adds over the store: only skills that reach the asking agent (`talkcode-hosts`,
 * `talkcode-harnesses`) are searched; a resident hit says it is already in the agent's list, so the
 * agent uses it from there instead of reading it again through the tool; and `show` of a version
 * this conversation already read answers "unchanged" instead of the whole text again — Hermes
 * Agent's skill_view does the same, for the same reason (a skill re-read every few turns is context
 * spent twice). `again` is the way past that, for an agent whose context was compacted since.
 *
 * Every search and every read goes into the query log (skill-queries.ts), which is where a search
 * that found nothing, or hits nobody opened, are read from.
 */

/** Who is asking: the agent answering the conversation, and where it runs. */
export interface LibraryAsker {
  conversation?: string;
  /** Incremented by `/new`: a read before it is not in the agent's context any more. */
  generation?: number;
  agent?: string;
  /** The agent's `host:`, or `local`. */
  host: string;
  /** As `talkcode-harnesses` names it (managed-skills.ts skillHarnessOf). */
  harness: string;
}

export interface SearchResult {
  name: string;
  description: string;
  category?: string;
  resident: boolean;
  /** Where the skill's files are on the asking agent's machine, from its last start. */
  path: string;
  /** Said for a resident hit: it is in the agent's own skill list already. */
  note?: string;
}

export interface SearchAnswer {
  query: string;
  results: SearchResult[];
  /** When nothing matched: what the library has, so the agent can rephrase or stop looking. */
  note?: string;
}

/** The maximum a search returns. Each result is a description the agent reads, so a few. */
export const SEARCH_LIMIT = 5;

const SKILLS_HOME = '~/.talkcode/skills';

export class SkillLibrary {
  private cached: { stamp: string; index: SkillIndex; skills: Map<string, SkillFileSet> } | undefined;
  /** Per conversation and generation: `name/file` → the version last shown in full. */
  private readonly shown = new Map<string, Map<string, string>>();

  constructor(private readonly dir: () => string = configDir) {}

  /**
   * The skills that can be searched, and an index over them, rebuilt only when one changed.
   *
   * "Changed" is judged by `activeSkillStamp` (stat only), not by the content versions it used to
   * compare: those meant reading and hashing every file of every skill on every search, which was
   * the whole cost of a search. The stamp is taken BEFORE the files are read, so a write landing in
   * between moves the next stamp — the worst a race costs is one extra rebuild, never an index
   * older than the stamp it is filed under.
   */
  private library(): { index: SkillIndex; skills: Map<string, SkillFileSet> } {
    const dir = this.dir();
    const stamp = `${dir}\n${activeSkillStamp(dir)}`;
    if (this.cached?.stamp !== stamp) {
      const sets = activeSkillFiles(dir);
      const docs: SearchableSkill[] = sets.map((s) => {
        const md = s.files.get(SKILL_FILE)?.toString('utf8') ?? '';
        return { name: s.name, description: descriptionOf(md), ...(s.meta.category ? { category: s.meta.category } : {}), body: skillBody(md) };
      });
      this.cached = { stamp, index: new SkillIndex(docs), skills: new Map(sets.map((s) => [s.name, s])) };
    }
    return this.cached;
  }

  search(query: string, asker: LibraryAsker, now = Date.now()): SearchAnswer {
    const { index, skills } = this.library();
    const reaching = (name: string): boolean => {
      const s = skills.get(name);
      return s !== undefined && skillReaches(s.meta, asker.host, asker.harness);
    };
    // Ask for more than the limit: hits that do not reach this agent are dropped after ranking.
    const hits = index.search(query, SEARCH_LIMIT * 4).filter((h) => reaching(h.name)).slice(0, SEARCH_LIMIT);
    const results = hits.map((h): SearchResult => {
      const s = skills.get(h.name)!;
      const md = s.files.get(SKILL_FILE)?.toString('utf8') ?? '';
      return {
        name: h.name,
        description: descriptionOf(md),
        ...(s.meta.category ? { category: s.meta.category } : {}),
        resident: s.meta.resident,
        path: `${SKILLS_HOME}/${h.name}/${SKILL_FILE}`,
        ...(s.meta.resident ? { note: 'already in your skill list: use it from there' } : {}),
      };
    });
    recordQueryEvent(this.dir(), {
      kind: 'search',
      at: new Date(now).toISOString(),
      query,
      hits: results.map((r) => r.name),
      ...(asker.conversation ? { conversation: asker.conversation } : {}),
      ...(asker.agent ? { agent: asker.agent } : {}),
    });
    if (results.length > 0) return { query, results };
    const cats = this.categories().categories.map((c) => `${c.name} ${c.count}`).join(', ');
    return { query, results, note: `no skill matched${cats ? `; the library has: ${cats}` : ''}` };
  }

  /**
   * How many skills, and per category (resident and library both), for the tool's description.
   * Each category also names its library skills — the ones not already in the agent's own skill
   * list — that reach `asker`, when one is given: a name is what makes an agent look a skill up.
   */
  categories(asker?: LibraryAsker): {
    total: number;
    library: number;
    categories: Array<{ name: string; count: number; library: string[] }>;
  } {
    const { skills } = this.library();
    const counts = new Map<string, { count: number; library: string[] }>();
    let library = 0;
    for (const s of skills.values()) {
      if (!s.meta.resident) library++;
      const c = s.meta.category ?? 'other';
      const entry = counts.get(c) ?? { count: 0, library: [] };
      entry.count++;
      if (!s.meta.resident && (!asker || skillReaches(s.meta, asker.host, asker.harness))) entry.library.push(s.name);
      counts.set(c, entry);
    }
    const categories = [...counts]
      .map(([name, e]) => ({ name, count: e.count, library: e.library.sort() }))
      // The uncategorized last whatever their number: "other 12" first would say nothing about the library.
      .sort((a, b) => Number(a.name === 'other') - Number(b.name === 'other') || b.count - a.count || a.name.localeCompare(b.name));
    return { total: skills.size, library, categories };
  }

  /**
   * One file of a skill, for the agent to follow. SKILL.md comes with the skill's other files and
   * where they are on the agent's machine; a version this conversation already read comes back as
   * a stub unless `again`. Counts as using the skill.
   */
  show(name: string, file: string | undefined, asker: LibraryAsker, again = false, now = Date.now()): unknown {
    const dir = this.dir();
    const shown = showSkill(name, file, dir);
    const seenKey = asker.conversation ? `${asker.conversation}#${asker.generation ?? 0}` : undefined;
    const fileKey = `${shown.name}/${shown.file}`;
    const seen = seenKey ? this.shown.get(seenKey) : undefined;
    recordQueryEvent(dir, {
      kind: 'show',
      at: new Date(now).toISOString(),
      name: shown.name,
      ...(asker.conversation ? { conversation: asker.conversation } : {}),
      ...(asker.agent ? { agent: asker.agent } : {}),
    });
    if (shown.status !== 'archived') recordSkillUse(shown.name, asker.agent, 'read', dir, now);
    if (!again && seen?.get(fileKey) === shown.version) {
      return {
        name: shown.name,
        file: shown.file,
        version: shown.version,
        unchanged: true,
        note: 'unchanged since this conversation read it; show it again with --again if it is no longer in your context',
      };
    }
    if (seenKey) {
      const map = seen ?? new Map<string, string>();
      map.set(fileKey, shown.version);
      this.shown.set(seenKey, map);
    }
    if (shown.file !== SKILL_FILE) return shown;
    const files = listSkillFiles(shown.name, dir)
      .map((f) => f.path)
      .filter((p) => p !== SKILL_FILE);
    return { ...shown, path: `${SKILLS_HOME}/${shown.name}`, ...(files.length > 0 ? { files } : {}) };
  }

  /** The misses of one conversation since a time — what the review is shown as a hint. */
  missesOf(conversation: string, sinceMs: number): string[] {
    return missesOf(readQueryEvents(this.dir()), conversation, sinceMs);
  }
}

function descriptionOf(md: string): string {
  return frontmatterFields(md).get('description')?.trim() ?? '';
}

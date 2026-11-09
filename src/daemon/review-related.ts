import { SkillIndex } from './skill-index.js';

/**
 * Which skills, and which of their files, a review is given in full besides the ones the
 * conversation used.
 *
 * Until 2026-11-09 a review saw every other skill as one line — name, version, description — and
 * that was the whole of what it knew about them. Measured on the gateway's 43 reviews from
 * 2026-11-07 to 11-08: three reviews of agy conversations wrote three reference files on one subject
 * (the 256k compaction budget) into antigravity-config, the third from a conversation that only
 * looked the earlier findings up, because none of them was shown that skill's files; and `edit`
 * needs the text it replaces, so a review could not have extended them even had it known. So the
 * skills closest to what the conversation was about come in full too, with the files of every
 * skill shown that are closest to it.
 *
 * Both choices reuse the skill search's own ranking (skill-index.ts) and are pure: the review
 * decides what is searchable and what fits, this decides the order.
 */

/** How many skills beyond the used ones are given in full. */
export const MAX_RELATED_SKILLS = 3;

/**
 * What the related skills' SKILL.md and every quoted file may take together, in characters. The
 * used skills' SKILL.md are not counted — they were given before this existed and still are.
 */
export const RELATED_CHARS = 30_000;

/** A file longer than this is named, never quoted: a review edits a few lines, it does not need 20 KB. */
export const QUOTED_FILE_CHARS = 6_000;

/** How much of the person's side of the conversation the search reads. */
const QUERY_CHARS = 4_000;

/** Files that may be quoted: prose under references/, not scripts or templates. */
const QUOTABLE = /^references\/.+\.(?:md|txt)$/;

/**
 * What the conversation is about, as a search query: its title and what the person wrote. Not the
 * agent's replies — they are long, and every long text matches every skill on some word; the
 * person's own words are what the conversation was for.
 */
export function reviewQuery(title: string, messages: ReadonlyArray<{ role: string; text: string }>): string {
  const said = messages.filter((m) => m.role === 'user').map((m) => m.text);
  // A library title leads with the agent that answered (`[cbc@uniagent] …`): on the gateway that is
  // every conversation, and it alone matched uniagent-dev's description to all of them.
  return [title.replace(/^\[[^\]]*\]\s*/, ''), ...said].join('\n').slice(0, QUERY_CHARS);
}

/**
 * The skills whose name, description or category best match `query`, best first, leaving out
 * `exclude`. The body is not searched: a description is the line written to say when a skill
 * applies, and a long body shares some word with any conversation.
 */
export function relatedSkillNames(
  query: string,
  skills: ReadonlyArray<{ name: string; description: string; category?: string }>,
  exclude: ReadonlySet<string>,
  limit = MAX_RELATED_SKILLS
): string[] {
  const index = new SkillIndex(skills.map((s) => ({ name: s.name, description: s.description, ...(s.category ? { category: s.category } : {}), body: '' })));
  return index
    .search(query, limit + exclude.size)
    .map((h) => h.name)
    .filter((name) => !exclude.has(name))
    .slice(0, limit);
}

/** Whether a skill's file is one a review may be shown in full. */
export function quotable(file: string): boolean {
  return QUOTABLE.test(file);
}

/**
 * `files` (keyed `<skill>/<file>`) best first for `query`, the weak tail dropped — the skill
 * search's own floor (MIN_SHARE_OF_BEST), so a file that shares a word or two is not quoted.
 */
export function rankFiles(query: string, files: ReadonlyArray<{ key: string; content: string }>): string[] {
  if (files.length === 0) return [];
  const index = new SkillIndex(files.map((f) => ({ name: f.key, description: '', body: f.content })));
  return index.search(query, files.length).map((h) => h.name);
}

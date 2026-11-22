import { type Locale, tMenus } from './i18n/menus.js';

/**
 * The `/skills` catalogue: the skills installed for an agent, rendered as text (pure functions).
 *
 * The data comes from disk (daemon/skills-scan.ts), not from what the agent reports over ACP —
 * that history is in the scanner's header, along with the coupling it costs.
 *
 * ── Why text and not buttons ──────────────────────────────────────────────────
 * A picker was the obvious design and it does not fit: 26 skills are installed here and Discord
 * caps an interactive message at 25 buttons, so a picker is a paging UI before it is anything else,
 * and paging to find a name is worse than reading a list.
 *
 * The deeper reason is that buttons cannot carry free text. A tapped button would have to park a
 * "pending skill" on the conversation and wait for the user's next message to complete it, which
 * buys a state machine, an expiry policy, and a class of bug where an unrelated message arrives
 * first and gets absorbed. None of that is needed: typing `/server-ops check the disk` ALREADY
 * reaches the agent, because a name outside the generic vocabulary passes through untouched (see
 * ConversationRegistry.route). Invocation was never the gap — discovery was, and a list answers it.
 */

/** One installed skill: the name a user types, and the directory it was found in. */
export interface CatalogEntry {
  name: string;
  dir: string;
}

/**
 * Render the catalogue for one agent.
 *
 * One skill per line. A comma-joined run of 26 names is unreadable on a phone — nothing to scan
 * down, no way to pick a name out at a glance — and it saves nothing, since one-per-line only
 * trades `, ` for `\n` (709 chars against 560 for the 26 installed here). The first version of
 * this joined with commas to be compact; compactness was never the constraint.
 *
 * Names only, no descriptions. A skill's `description` frontmatter is written for a model deciding
 * whether to load it and runs to hundreds of characters — `server-ops` alone is over 300 — so 26 of
 * them fit in no platform's message. Names are what a reader needs in order to type the next
 * message; the agent itself can explain any one.
 *
 * The example uses a real name from the list rather than a placeholder, because the one thing a
 * reader has to learn here is that the name takes a request after it.
 */
export function formatSkillCatalog(
  agentLabel: string,
  skills: readonly CatalogEntry[],
  locale: Locale = 'en'
): string {
  const skillsWord = skills.length === 1 ? tMenus(locale, 'skills_word_single') : tMenus(locale, 'skills_word_plural');
  const lines = [
    tMenus(locale, 'skills_catalog_header', { agentLabel, count: skills.length, skillsWord }),
    '',
    ...skills.map((s) => `\`/${s.name}\``),
  ];
  const example = skills[0]?.name;
  if (example) {
    lines.push('', tMenus(locale, 'skills_catalog_example', { example }));
  }
  return lines.join('\n');
}

/**
 * What to say when nothing was found.
 *
 * Names the directories that were searched, which is the whole of the diagnosis: either the harness
 * installs no skills (dsh — nothing has been found for it) or they live somewhere this does not
 * look, and only the operator can tell which. Saying "no skills" without saying where it looked
 * leaves them with nothing to check.
 *
 * An empty `dirs` means the harness has no known skills location at all, which is a different
 * sentence — there is no path to print and nothing for the operator to go and inspect.
 */
export function formatEmptyCatalog(agentLabel: string, dirs: readonly string[], locale: Locale = 'en'): string {
  if (dirs.length === 0) {
    return tMenus(locale, 'skills_empty_no_dir', { agentLabel });
  }
  const where = dirs.map((d) => `\`${d}\``).join(', ');
  return tMenus(locale, 'skills_empty_searched', { agentLabel, where });
}

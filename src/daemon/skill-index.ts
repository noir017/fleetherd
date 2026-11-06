import { indexText } from '../history/tokenize.js';

/**
 * The search behind the `skills` tool: which library skills fit what an agent says it needs.
 *
 * ── Why a search at all ──────────────────────────────────────────────────────────────────────────
 * A resident skill costs its name and description in every request of every agent. Past a few
 * dozen that is the context budget gone before the work starts, so most skills live in the library
 * tier: on disk on every host, listed nowhere, and found here. Hermes Agent, read on 2026-11-06
 * (commit 90d6b98), lists every skill in its system prompt instead and has no search; that works
 * for one agent whose prompt it owns, which a gateway in front of five harnesses is not.
 *
 * ── How it ranks ─────────────────────────────────────────────────────────────────────────────────
 * BM25 over four fields, weighted: the name 3, the description 2, the category 1.5, the body 1 —
 * the description is the line written to say when the skill applies, so it outranks a passing
 * mention in a long body. Text is split the way the conversation library splits it
 * (history/tokenize.ts): Han runs into overlapping two-character words, everything else into
 * words, lowercased, so 「部署检查」 finds a skill saying 「检查部署」 by their shared 「部署」 and
 * 「检查」. Terms are ORed: a query is a description of a need, not a filter.
 *
 * Pure: built from the skills it is handed, no filesystem, so the daemon decides what is
 * searchable (active, valid, reaching the asking agent) and this decides only the order.
 */

export interface SearchableSkill {
  name: string;
  description: string;
  category?: string;
  /** SKILL.md without its frontmatter. */
  body: string;
}

export interface SkillHit {
  name: string;
  score: number;
}

const FIELDS = [
  { key: 'name', weight: 3 },
  { key: 'description', weight: 2 },
  { key: 'category', weight: 1.5 },
  { key: 'body', weight: 1 },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

const K1 = 1.2;
const B = 0.75;

/**
 * A hit scoring under this share of the best one is dropped. Every result is a description the
 * agent reads, and on agent-skills' own library (2026-11-06, eight queries in English and Chinese)
 * the right skill came first every time while the tail was words in common — `uniagent-dev` for
 * "email verification code" at a third of `email-reader`'s score.
 */
export const MIN_SHARE_OF_BEST = 0.4;

/** The terms of a text, as the index and the query both split it. */
export function skillTerms(text: string): string[] {
  return [...indexText(text).toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => m[0]);
}

interface Doc {
  name: string;
  tf: Record<FieldKey, Map<string, number>>;
  len: Record<FieldKey, number>;
}

function counts(terms: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export class SkillIndex {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avg: Record<FieldKey, number>;

  constructor(skills: SearchableSkill[]) {
    this.docs = skills.map((s) => {
      const text: Record<FieldKey, string> = {
        name: s.name.replace(/-/g, ' '),
        description: s.description,
        category: s.category ?? '',
        body: s.body,
      };
      const tf = {} as Record<FieldKey, Map<string, number>>;
      const len = {} as Record<FieldKey, number>;
      for (const f of FIELDS) {
        const terms = skillTerms(text[f.key]);
        tf[f.key] = counts(terms);
        len[f.key] = terms.length;
      }
      const seen = new Set<string>();
      for (const f of FIELDS) for (const t of tf[f.key].keys()) seen.add(t);
      for (const t of seen) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { name: s.name, tf, len };
    });
    const n = Math.max(1, this.docs.length);
    this.avg = {} as Record<FieldKey, number>;
    for (const f of FIELDS) this.avg[f.key] = Math.max(1, this.docs.reduce((sum, d) => sum + d.len[f.key], 0) / n);
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * The best `limit` skills for `query`, best first; only those that share a term with it. A query
   * that is a skill's name (`server-ops`, `server ops`) puts that skill first whatever the rest says.
   */
  search(query: string, limit = 5): SkillHit[] {
    const terms = [...new Set(skillTerms(query))];
    if (terms.length === 0) return [];
    const exact = query.trim().toLowerCase().replace(/\s+/g, '-');
    const n = this.docs.length;
    const hits: SkillHit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of terms) {
        const df = this.df.get(t);
        if (!df) continue;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        for (const f of FIELDS) {
          const tf = d.tf[f.key].get(t);
          if (!tf) continue;
          const norm = tf + K1 * (1 - B + (B * d.len[f.key]) / this.avg[f.key]);
          score += f.weight * idf * ((tf * (K1 + 1)) / norm);
        }
      }
      if (d.name === exact) score += 100;
      if (score > 0) hits.push({ name: d.name, score });
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const floor = (hits[0]?.score ?? 0) * MIN_SHARE_OF_BEST;
    return hits.filter((h) => h.score >= floor).slice(0, limit);
  }
}

/** SKILL.md without its frontmatter, for the body field. */
export function skillBody(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

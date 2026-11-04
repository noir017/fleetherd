/**
 * CJK-aware tokenising for the conversation index.
 *
 * SQLite's `unicode61` tokenizer splits on punctuation and whitespace, and treats a run of
 * Chinese characters as ONE token — so a message containing 「跨会话查询」 indexes the single
 * token 「跨会话查询」 and can never be found by searching 「查询」. `trigram` fixes that the
 * other way round and cannot match a two-character word (measured 2026-11-04 on SQLite 3.53.4,
 * the version Node 24 bundles).
 *
 * So the text is split here, before it reaches SQLite: every run of Han characters becomes its
 * overlapping two-character words — 「跨会话查询」 → `跨会 会话 话查 查询` — while everything
 * else is left for `unicode61`. The same split runs on the query, so a two-character search
 * word is itself one of the indexed tokens.
 *
 * A one-character run has no bigram to make. It is indexed as itself and searched with LIKE
 * (`queryTerms` reports it under `single`), because a single character is too common for a
 * full-text hit to mean anything anyway.
 */

/**
 * Han characters: CJK Unified Ideographs (and Ext A), compatibility ideographs, and Ext B+.
 * Deliberately not kana or Hangul — those tokenize sensibly under `unicode61` already, and
 * splitting them into bigrams would make Japanese text match almost anything.
 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]+/gu;

/** Every other letter/number run — Latin words, digits, Cyrillic, kana, Hangul. */
const WORD = /[\p{L}\p{N}_]+/gu;

/** The bigrams of one Han run, in order. A one-character run yields itself. */
export function hanTerms(run: string): string[] {
  const chars = Array.from(run);
  if (chars.length <= 1) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/**
 * The text as it goes into the FTS index: Han runs replaced by their bigrams, separated by
 * spaces, with the rest of the text kept as it was. Punctuation is harmless — `unicode61`
 * treats it as a separator.
 */
export function indexText(text: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const m of text.matchAll(HAN)) {
    const start = m.index ?? 0;
    const before = text.slice(at, start);
    if (before) parts.push(before);
    parts.push(hanTerms(m[0]).join(' '));
    at = start + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts.join(' ');
}

/** A query split the way the index was: full-text terms, and single characters left for LIKE. */
export interface QueryTerms {
  /** Terms joined with AND for the FTS `MATCH`. Empty when the query has no word at all. */
  fts: string[];
  /** One-character Han terms, matched with LIKE against the original text. */
  single: string[];
}

/**
 * Split a search query into what the index can answer.
 *
 * Han runs of two or more characters become bigrams (all of them, ANDed: a search for
 * 「跨会话查询」 asks for every one of `跨会 会话 话查 查询`, which is what makes it specific).
 * Everything else is a word term. A lone Han character is a LIKE term.
 */
export function queryTerms(query: string): QueryTerms {
  const fts: string[] = [];
  const single: string[] = [];
  const rest: string[] = [];
  let at = 0;
  for (const m of query.matchAll(HAN)) {
    const start = m.index ?? 0;
    rest.push(query.slice(at, start));
    // The run's LENGTH decides, not how many terms it produced: a two-character word is one
    // bigram, and belongs in the full-text query exactly like a longer run's bigrams do.
    if (Array.from(m[0]).length === 1) single.push(m[0]);
    else fts.push(...hanTerms(m[0]));
    at = start + m[0].length;
  }
  rest.push(query.slice(at));
  for (const m of rest.join(' ').matchAll(WORD)) {
    // A one-letter Latin word is still a word; `unicode61` indexes it as one.
    if (m[0].length >= 1) fts.push(m[0]);
  }
  return { fts: dedupe(fts), single: dedupe(single) };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * An FTS5 MATCH expression for these terms: each quoted (a term may contain punctuation the
 * parser would otherwise read as syntax) and ANDed. Undefined when there is nothing to match.
 */
export function ftsQuery(terms: string[]): string | undefined {
  if (terms.length === 0) return undefined;
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ');
}

/**
 * A short excerpt of `text` around the first term it contains, for a search result.
 *
 * Taken from the original text, not from the index: the index holds bigrams (`跨会 会话 …`),
 * which are not what a person — or an agent — wants to read.
 */
export function excerpt(text: string, terms: string[], width = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  let at = -1;
  for (const term of terms) {
    const i = flat.toLowerCase().indexOf(term.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return `${flat.slice(0, width - 1)}…`;
  // Centre the hit rather than showing only the start of the match.
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

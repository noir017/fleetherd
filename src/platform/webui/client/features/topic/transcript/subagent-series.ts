import { seqOf } from './btw.js';
import { parseSubagent, type ParsedSubagent } from './markup.js';
import type { TranscriptMessage } from './types.js';

/** One subagent, however many messages it was drawn in. */
export interface SubagentRow {
  /** Its first message: where the transcript keeps its line, and the bar's key for its row. */
  readonly key: string;
  /** Every message it was drawn in, oldest first. */
  readonly keys: readonly string[];
  /** When its newest message was sent: the bar lists the latest first. */
  readonly at: number;
  readonly order: number;
  /** Name, state and duration from the newest message; the tools of all of them. */
  readonly p: ParsedSubagent;
}

interface Member {
  readonly key: string;
  readonly m: TranscriptMessage;
  readonly p: ParsedSubagent;
  readonly order: number;
}

interface Line {
  html: string;
  /** What the line says the call is: the same in every message that shows it. */
  readonly call: string;
  readonly done: boolean;
  readonly tool: boolean;
}

/**
 * The topic's subagents (kind `subagent`), one row each. Messages sharing a `series` are one
 * subagent (SendOptions.series): a card that outgrew its message and went on in another, or a
 * card the daemon opened for it again in a later turn. A message without one is a subagent alone.
 */
export class SubagentIndex {
  private rowList: SubagentRow[] | null = null;
  private readonly byKey = new Map<string, SubagentRow>();
  private readonly merged = new Map<string, { readonly htmls: readonly string[]; readonly p: ParsedSubagent }>();

  constructor(
    private readonly getData: () => Record<string, TranscriptMessage | undefined>,
    private readonly doc: () => Document,
  ) {}

  /** A subagent message changed, came or went. */
  invalidate(): void {
    this.rowList = null;
  }

  rows(): readonly SubagentRow[] {
    if (!this.rowList) this.build();
    return this.rowList ?? [];
  }

  /** The row a message is part of, if it is a subagent's. */
  rowOf(key: string): SubagentRow | undefined {
    if (!this.rowList) this.build();
    return this.byKey.get(key);
  }

  private build(): void {
    const groups = new Map<string, Member[]>();
    let order = 0;
    for (const [key, m] of Object.entries(this.getData())) {
      order++;
      if (!m || m.kind !== 'subagent') continue;
      const p = parseSubagent(m.html);
      if (!p) continue;
      const id = m.series ? `s:${m.series}` : `k:${key}`;
      const list = groups.get(id);
      if (list) list.push({ key, m, p, order });
      else groups.set(id, [{ key, m, p, order }]);
    }
    const rows: SubagentRow[] = [];
    this.byKey.clear();
    for (const [id, list] of groups) {
      list.sort(sent);
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) continue;
      const row: SubagentRow = {
        key: first.key,
        keys: list.map((x) => x.key),
        at: last.m.at,
        order: last.order,
        p: list.length === 1 ? last.p : this.merge(id, first, list),
      };
      rows.push(row);
      for (const k of row.keys) this.byKey.set(k, row);
    }
    for (const id of this.merged.keys()) if (!groups.has(id)) this.merged.delete(id);
    this.rowList = rows;
  }

  private merge(id: string, first: Member, list: readonly Member[]): ParsedSubagent {
    const htmls = list.map((x) => x.m.html);
    const hit = this.merged.get(id);
    if (hit && hit.htmls.length === htmls.length && hit.htmls.every((h, i) => h === htmls[i])) return hit.p;
    const p = mergeParts([first.p, ...list.slice(1).map((x) => x.p)], this.doc());
    this.merged.set(id, { htmls, p });
    return p;
  }
}

/** Oldest first: by the server's message sequence where both have one, else by time. */
function sent(a: Member, b: Member): number {
  const sa = seqOf(a.m.id);
  const sb = seqOf(b.m.id);
  if (sa > 0 && sb > 0 && sa !== sb) return sa - sb;
  return a.m.at - b.m.at || a.order - b.order;
}

/**
 * One subagent from the messages it was drawn in, oldest first. The newest says how it is doing;
 * the tools are all of theirs, in order — less the lines an older message showed still running that
 * a later one carries on: a card that fills its message repeats those in the next
 * (core/tool-renderer.ts seal), so the same call would otherwise be listed twice.
 */
export function mergeParts(parts: readonly [ParsedSubagent, ...ParsedSubagent[]], doc: Document): ParsedSubagent {
  const last = parts[parts.length - 1] ?? parts[0];
  if (parts.length === 1) return last;
  const lines = parts.map((p) => linesOf(p.body, doc));
  const later = new Map<string, number>();
  const kept: Line[][] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const own = lines[i] ?? [];
    kept[i] = own.filter((l) => i === lines.length - 1 || l.done || !take(later, l.call));
    for (const l of own) later.set(l.call, (later.get(l.call) ?? 0) + 1);
  }
  const body = kept.flat();
  return {
    ...last,
    body: `<div class="tools">${body.map((l) => l.html).join('')}</div>`,
    tools: body.filter((l) => l.tool).length,
  };
}

function take(counts: Map<string, number>, call: string): boolean {
  const n = counts.get(call) ?? 0;
  if (n === 0) return false;
  counts.set(call, n - 1);
  return true;
}

/** A card's tool lines (web-markdown.ts renderWebToolLines), each with what is drawn under it. */
function linesOf(body: string, doc: Document): Line[] {
  const t = doc.createElement('template');
  t.innerHTML = body;
  const root = t.content.querySelector('.tools') ?? t.content;
  const out: Line[] = [];
  for (const el of Array.from(root.children)) {
    const prev = out[out.length - 1];
    if (!el.classList.contains('tl') && prev) {
      prev.html += el.outerHTML;
      continue;
    }
    const tool = el.classList.contains('tl');
    out.push({
      html: el.outerHTML,
      call: el.querySelector('.tl-c')?.innerHTML ?? el.innerHTML,
      done: !tool || el.querySelector('.tl-s') !== null,
      tool,
    });
  }
  return out;
}

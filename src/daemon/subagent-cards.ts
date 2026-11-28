import { subagentHeader, type ToolRenderer } from '../core/tool-renderer.js';
import type { ToolEvent, ToolFinishEvent } from '../types.js';

/** What a card is called when the call that started its subagent never named it. */
const UNNAMED = 'subagent';

interface Card {
  renderer: ToolRenderer;
  name: string;
  startedAt: number;
  ended: boolean;
}

/**
 * One render's subagents, each drawn as a card of its own: a ToolRenderer headed with the
 * subagent's name (subagentHeader) that carries that subagent's tools and nothing else, so parallel
 * subagents and the main agent's own calls never share a bubble.
 *
 * A card opens with its subagent's first tool, keyed by the call that started it (ToolEvent.parent).
 * It ends — its header takes ✓ or ✗ and how long it ran — when:
 * - the harness says so (claude's native subagent sessions, acp-native-subagents.ts);
 * - the call that started it finishes, for a foreground subagent (that call lasts as long as it);
 * - the render ends, for a background one. claude-agent-acp holds a turn open until the background
 *   subagents it spawned are done (Turn.deferredSettle, 0.81), so the turn's end is theirs;
 * - the render is stopped, with ✗.
 * A tool that arrives for a card that has ended opens it again. The cards are per render, so a
 * subagent resumed after its render ended gets a new card in the next one; `make` is handed the
 * card's key so every message of it — that one, and a bubble the card overflowed into — is sent
 * under it (SendOptions.series), and the web UI draws them as one subagent.
 */
export class SubagentCards {
  private readonly cards = new Map<string, Card>();

  constructor(
    private readonly make: (key: string) => ToolRenderer,
    private readonly now: () => number
  ) {}

  /** A subagent's tool started (or was reported again). The main agent's own tools are not this class's. */
  onToolStart(evt: ToolEvent): void {
    if (evt.parent === undefined) return;
    let card = this.cards.get(evt.parent);
    if (!card) {
      card = { renderer: this.make(evt.parent), name: evt.agent ?? UNNAMED, startedAt: this.now(), ended: false };
      this.cards.set(evt.parent, card);
    }
    card.ended = false;
    card.renderer.setHeader(subagentHeader(card.name));
    card.renderer.onToolStart(evt);
  }

  /** A tool finished: a subagent's goes to its card; a foreground subagent's starting call ends that card. */
  onToolFinish(evt: ToolFinishEvent): void {
    if (evt.parent !== undefined) {
      this.cards.get(evt.parent)?.renderer.onToolFinish(evt);
      return;
    }
    if (evt.spawns === 'foreground' && evt.id !== undefined) this.end(evt.id, evt.ok);
  }

  /** The harness said this subagent ended (AgentStreamHandlers.onSubagentEnd). */
  onSubagentEnd(parent: string, ok: boolean): void {
    this.end(parent, ok);
  }

  /** The render is over: every card still open ends with it — ✓ when it ended normally, ✗ when stopped. */
  endAll(ok: boolean): void {
    for (const id of this.cards.keys()) this.end(id, ok);
  }

  /** Resolve once every card has painted what it has, or `timeoutMs` has passed (ToolRenderer.settle). */
  async settle(timeoutMs: number): Promise<void> {
    await Promise.all([...this.cards.values()].map((c) => c.renderer.settle(timeoutMs)));
  }

  abort(): void {
    for (const c of this.cards.values()) c.renderer.abort();
  }

  private end(id: string, ok: boolean): void {
    const card = this.cards.get(id);
    if (!card || card.ended) return;
    card.ended = true;
    card.renderer.setHeader(subagentHeader(card.name, { ok, durationMs: this.now() - card.startedAt }));
  }
}

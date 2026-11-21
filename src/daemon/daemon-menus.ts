import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import {
  agentGroups,
  buildAgentMenu,
  flatAgents,
  parseAgentButtonId,
  type AgentButtonClick,
  type AgentGroup,
} from '../core/agent-menu.js';
import { parseButtonId, PICK_PREFIX, parsePickButtonId } from '../core/button-id.js';
import {
  genericNativeNames,
  harnessCommandName,
  SLASH_DESC_MAX,
  SLASH_NAME_RE,
} from '../core/command-translate.js';
import { addressOf, type ConversationAddress, type ConversationRef } from '../core/conversation.js';
import {
  buildEffortMenu,
  effortChoiceText,
  effortMenuExpiredText,
  effortMenuSupersededText,
  parseEffortButtonId,
  type EffortButtonClick,
  type EffortOption,
} from '../core/effort-menu.js';
import {
  buildModelMenu,
  modelChoiceText,
  modelIndexOf,
  modelMenuExpiredText,
  modelMenuSupersededText,
  modelPageOf,
  parseModelButtonId,
  type ModelButtonClick,
  type ModelOption,
} from '../core/model-menu.js';
import { resolvePageSize, WORKDIR_PAGE_SIZE_MAX } from '../core/paging.js';
import { taskListText } from '../core/schedule.js';
import {
  buildScheduleDeleteConfirm,
  buildScheduleListMenu,
  buildScheduleTaskMenu,
  parseScheduleButtonId,
  scheduleEntryLabel,
  scheduleMenuExpiredText,
  scheduleOpenButtonId,
  type ScheduleMenuAction,
  type ScheduleMenuClick,
} from '../core/schedule-menu.js';
import {
  buildSettingValueMenu,
  buildSettingsMenu,
  modelListAgent,
  parseSettingButtonId,
  settingNotice,
  settingValuePage,
  settingsMenuExpiredText,
  settingsMenuSupersededText,
  type SettingButtonClick,
  type SettingChoice,
  type SettingOption,
  type SettingRow,
  type SettingsScreenInput,
} from '../core/settings.js';
import { parseRetryButtonId, type RetryButtonClick } from '../core/turn-retry.js';
import {
  buildWorkdirMenu,
  parseWorkdirButtonId,
  workdirChoiceText,
  workdirIndexOf,
  workdirMenuExpiredText,
  workdirMenuSupersededText,
  workdirPageOf,
  type WorkdirButtonClick,
  type WorkdirOption,
} from '../core/workdir-menu.js';
import {
  DEFAULT_ASK_TIMEOUT_MS as PROTOCOL_DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_ASK_REMINDER_MS,
  DEFAULT_ASK_REMINDER_TEXT,
} from '../ipc/protocol.js';
import type { ButtonSpec, PlatformAdapter } from '../platform/adapter.js';
import type {
  AgentCommand,
  AgentElicitation,
  AgentPermissionRequest,
  ButtonInteraction,
  ConversationId,
  EffortSelector,
  ElicitAnswer,
  ElicitQuestion,
  InboundMessage,
  MessageRef,
  ModelSelector,
  PermissionAnswer,
  SettingsScreen,
  SlashCommandSpec,
} from '../types.js';
import type { AskButtonsOptions, AskOutcome, DaemonContext } from './daemon-context.js';

const DEFAULT_ASK_TIMEOUT_MS = PROTOCOL_DEFAULT_ASK_TIMEOUT_MS;
const PICKER_BUTTON_MAX = 25;
const ASK_PREFIX = 'ask:';
const ASK_ECHO_MAX = 300;
const PERMISSION_TITLE_MAX = 600;

const SCHEDULE_TYPED_OPS: Record<string, 'pause' | 'resume' | 'remove' | 'run'> = {
  pause: 'pause',
  resume: 'resume',
  delete: 'remove',
  remove: 'remove',
  rm: 'remove',
  run: 'run',
};

const MULTI_HINT = '_Tap to select as many as apply, then tap Done._';
const MULTI_EMPTY_NOTE = '_Nothing selected yet — tick at least one option, or type your own answer._';
const MULTI_DEGRADED_NOTE =
  '_This question takes more than one answer, which this platform cannot offer as buttons — tap the most important one, or type them all as a reply._';

export function parseAskButtonId(buttonId: string): { reqId: string; index: number } | null {
  const parsed = parseButtonId(buttonId, ASK_PREFIX);
  return parsed && { reqId: parsed.reqId, index: parsed.n };
}

export function agentCommandToSpec(cmd: AgentCommand): SlashCommandSpec | null {
  if (!SLASH_NAME_RE.test(cmd.name)) return null;
  const description = (cmd.description || cmd.name).slice(0, SLASH_DESC_MAX);
  const spec: SlashCommandSpec = { name: cmd.name, description };
  if (cmd.hint) {
    spec.options = [
      { name: 'input', description: cmd.hint.slice(0, SLASH_DESC_MAX), type: 'string', required: false },
    ];
  }
  return spec;
}

export function composeElicitPrompt(
  q: ElicitQuestion,
  index: number,
  total: number,
  note?: string
): string {
  const heading = total > 1 ? `(${index + 1}/${total}) ${q.prompt}` : q.prompt;
  const detail = q.options
    .filter((o) => o.description)
    .map((o) => `**${o.label}** — ${o.description}`)
    .join('\n');
  const body = detail ? `${heading}\n\n${detail}` : heading;
  return note ? `${body}\n\n${note}` : body;
}

export function composePermissionPrompt(title: string, timeoutMs: number, detail?: string): string {
  // Neutralize runs of 3+ backticks so a tool preview cannot break out of the fenced block.
  const shown = (title.length > PERMISSION_TITLE_MAX ? `${title.slice(0, PERMISSION_TITLE_MAX)}…` : title)
    .replace(/`{3,}/g, '``');
  const change = detail ? `\n\n\`\`\`\n${detail.replace(/`{3,}/g, '``')}\n\`\`\`` : '';
  const minutes = Math.round(timeoutMs / 60_000);
  return `🔐 The agent asks to run:\n\`\`\`\n${shown}\n\`\`\`${change}\nNo answer within ${minutes} min declines it.`;
}

function canMultiSelect(platform: PlatformAdapter, q: ElicitQuestion): boolean {
  return q.multi && platform.capabilities.editButtons;
}

export function buildAskButtons(
  reqId: string,
  labels: string[],
  selected?: ReadonlySet<number>
): ButtonSpec[] {
  const buttons: ButtonSpec[] = labels.map((label, i) => ({
    id: `${ASK_PREFIX}${reqId}:${i}`,
    label: selected ? `${selected.has(i) ? '☑' : '☐'} ${label}` : label,
  }));
  if (selected) {
    buttons.push({
      id: `${ASK_PREFIX}${reqId}:${labels.length}`,
      label: selected.size > 0 ? `✅ Done (${selected.size})` : '✅ Done',
      style: 'primary',
    });
  }
  return buttons;
}

interface ElicitGap {
  acceptsText: boolean;
  parked?: string;
  cancelled?: string;
}

interface PendingAsk {
  resolve: (outcome: AskOutcome | null) => void;
  timer: NodeJS.Timeout;
  reminderTimer?: NodeJS.Timeout;
  ref: MessageRef;
  labels: string[];
  prompt: string;
  adapter: PlatformAdapter;
  acceptsText: boolean;
  conversationId?: ConversationId;
  selected?: Set<number>;
}

interface PendingPick {
  conversationId: ConversationId;
  names: string[];
  conversation: ConversationRef;
  ref?: MessageRef;
}

interface PendingModelMenu {
  conversationId: ConversationId;
  agentId: string;
  conversation: ConversationRef;
  options: ModelOption[];
  current?: string;
  pageSize: number;
  ref?: MessageRef;
}

interface PendingEffortMenu {
  conversationId: ConversationId;
  agentId: string;
  conversation: ConversationRef;
  options: EffortOption[];
  current?: string;
  ref?: MessageRef;
}

type SettingsAck = { tone: 'ok' | 'info' | 'error'; text: string };

function expiredAck(): SettingsAck {
  return { tone: 'error', text: settingsMenuExpiredText() };
}

interface PendingSettingsMenu {
  conversationId: ConversationId;
  conversation: ConversationRef;
  rows: SettingRow[];
  open?: { row: SettingRow; options: SettingOption[]; hint?: string };
  choices?: SettingChoice[];
  pageSize: number;
  ref?: MessageRef;
}

interface PendingScheduleMenu {
  conversationId: ConversationId;
  conversation: ConversationRef;
  ref?: MessageRef;
  ids: string[];
  open?: { id: string; confirm: boolean };
  pageSize: number;
}

interface PendingWorkdirMenu {
  conversationId: ConversationId;
  agentId: string;
  conversation: ConversationRef;
  options: WorkdirOption[];
  current: string;
  pageSize: number;
  ref?: MessageRef;
}

interface PendingAgentMenu {
  conversationId: ConversationId;
  conversation: ConversationRef;
  groups: AgentGroup[];
  current: string | undefined;
  pageSize: number;
  ref?: MessageRef;
  retry?: string;
}

/** Owns all eight pending menu/ask tables, their expiry/retirement, and button click handling. */
export class DaemonMenus {
  private pendingAsks = new Map<string, PendingAsk>();
  private elicitGaps = new Map<ConversationId, ElicitGap>();
  private agentCommands = new Map<string, AgentCommand[]>();
  readonly pendingPicks = new Map<string, PendingPick>();
  private pendingModelMenus = new Map<string, PendingModelMenu>();
  private pendingEffortMenus = new Map<string, PendingEffortMenu>();
  private pendingSettingsMenus = new Map<string, PendingSettingsMenu>();
  private pendingScheduleMenus = new Map<string, PendingScheduleMenu>();
  private pendingWorkdirMenus = new Map<string, PendingWorkdirMenu>();
  private pendingAgentMenus = new Map<string, PendingAgentMenu>();

  constructor(private readonly ctx: DaemonContext) {}

  setAgentCommands(agentId: string, cmds: AgentCommand[]): void {
    if (cmds.length === 0) this.agentCommands.delete(agentId);
    else this.agentCommands.set(agentId, cmds);
  }

  hasPendingWork(id: ConversationId): boolean {
    for (const pending of this.pendingAsks.values()) {
      if (pending.conversationId === id) return true;
    }
    return false;
  }

  questionOf(conversationId: ConversationId): string | undefined {
    for (const pending of this.pendingAsks.values()) {
      if (pending.conversationId !== conversationId) continue;
      return pending.prompt.trim() || undefined;
    }
    return undefined;
  }

  clearMenus(): void {
    this.pendingPicks.clear();
    this.pendingModelMenus.clear();
    this.pendingEffortMenus.clear();
    this.pendingSettingsMenus.clear();
    this.pendingScheduleMenus.clear();
    this.pendingWorkdirMenus.clear();
    this.pendingAgentMenus.clear();
  }

  clearAsks(): void {
    for (const pending of this.pendingAsks.values()) {
      try {
        clearTimeout(pending.timer);
        if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
        pending.resolve(null);
      } catch {
        // Cleanup must not block exit.
      }
    }
    this.pendingAsks.clear();
    this.elicitGaps.clear();
  }

  askButtons(
    platform: PlatformAdapter,
    address: ConversationAddress,
    prompt: string,
    labels: string[],
    timeoutMs: number,
    conversationId?: ConversationId,
    opts: AskButtonsOptions = {}
  ): Promise<AskOutcome | null> {
    const reqId = randomUUID().slice(0, 8);
    const acceptsText = opts.acceptsText ?? true;
    const selected = opts.multi ? new Set<number>() : undefined;
    const buttons = buildAskButtons(reqId, labels, selected);
    return platform.sendButtons(
      address,
      selected ? `${prompt}\n\n${MULTI_HINT}` : prompt,
      buttons,
      undefined,
      opts.kind ? { kind: opts.kind } : undefined
    ).then(
      (ref) =>
        new Promise<AskOutcome | null>((resolve) => {
          const timer = setTimeout(() => {
            if (this.settleAsk(reqId, { kind: 'timeout' }, opts.timeoutNote ?? '(timed out)')) {
              if (conversationId !== undefined && timeoutMs >= DEFAULT_ASK_TIMEOUT_MS) {
                this.ctx.registry.reclaimAfterAskTimeout(conversationId);
              }
            }
          }, timeoutMs);
          const reminderTimer =
            timeoutMs > DEFAULT_ASK_REMINDER_MS
              ? setTimeout(() => {
                  void platform
                    .sendMessage(address, DEFAULT_ASK_REMINDER_TEXT)
                    .catch((err) =>
                      console.warn(
                        `[ask] ${conversationId ?? reqId}: failed to send reminder notice:`,
                        err instanceof Error ? err.message : err
                      )
                    );
                }, DEFAULT_ASK_REMINDER_MS)
              : undefined;
          this.pendingAsks.set(reqId, {
            resolve,
            timer,
            reminderTimer,
            ref,
            labels,
            prompt,
            adapter: platform,
            acceptsText,
            conversationId,
            ...(selected ? { selected } : {}),
          });
          opts.signal?.addEventListener('abort', () => this.settleAsk(reqId, null, '(replaced)'), { once: true });
          if (opts.signal?.aborted) this.settleAsk(reqId, null, '(replaced)');
          if (conversationId !== undefined) {
            this.settleFromGap(reqId, conversationId, acceptsText);
            if (this.pendingAsks.has(reqId)) this.ctx.delegation.childChanged(conversationId);
          }
        })
    );
  }

  private settleAsk(reqId: string, outcome: AskOutcome | null, shown: string): boolean {
    const pending = this.pendingAsks.get(reqId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
    this.pendingAsks.delete(reqId);
    pending.resolve(outcome);
    this.retireAsk(pending, shown);
    return true;
  }

  private settleFromGap(reqId: string, conversationId: ConversationId, acceptsText: boolean): void {
    const gap = this.elicitGaps.get(conversationId);
    if (!gap) return;
    if (gap.cancelled !== undefined) {
      this.settleAsk(reqId, null, `(${gap.cancelled})`);
      return;
    }
    if (acceptsText && gap.parked !== undefined) {
      const parked = gap.parked;
      gap.parked = undefined;
      this.answerPendingAskWithText(conversationId, parked);
    }
  }

  private retireAsk(pending: PendingAsk, outcome: string): void {
    const text = `${pending.prompt}\n\n${outcome}`;
    // Use editButtons([]) where supported; text-only editMessage leaves buttons live on Slack/Lark.
    const edit = pending.adapter.capabilities.editButtons
      ? pending.adapter.editButtons(pending.ref, text, [])
      : pending.adapter.editMessage(pending.ref, text);
    void edit.catch(() => undefined);
  }

  answerPendingAskWithText(conversationId: ConversationId, text: string): boolean {
    let match: string | undefined;
    for (const [reqId, pending] of this.pendingAsks) {
      if (pending.conversationId === conversationId && pending.acceptsText) match = reqId;
    }
    if (match === undefined) {
      const gap = this.elicitGaps.get(conversationId);
      if (!gap?.acceptsText || gap.parked !== undefined || gap.cancelled !== undefined) return false;
      gap.parked = text;
      console.log(`[ask] ${conversationId}: answer parked for the question being posted`);
      return true;
    }
    const echo = text.length > ASK_ECHO_MAX ? `${text.slice(0, ASK_ECHO_MAX)}…` : text;
    this.settleAsk(match, { kind: 'text', text }, `→ Answered: ${echo}`);
    console.log(`[ask] ${conversationId}: question answered by a typed reply`);
    return true;
  }

  cancelPendingAsks(conversationId: ConversationId, reason: string): number {
    const gap = this.elicitGaps.get(conversationId);
    if (gap && gap.cancelled === undefined) {
      gap.cancelled = reason;
      gap.parked = undefined;
    }
    let cancelled = 0;
    for (const [reqId, pending] of [...this.pendingAsks]) {
      if (pending.conversationId !== conversationId) continue;
      if (this.settleAsk(reqId, null, `(${reason})`)) cancelled++;
    }
    if (cancelled > 0) console.log(`[ask] ${conversationId}: ${cancelled} question(s) called off (${reason})`);
    return cancelled;
  }

  async onPermissionRequest(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentPermissionRequest
  ): Promise<PermissionAnswer> {
    if (!platform.capabilities.buttons) {
      return { kind: 'unavailable', why: `${platform.platformType} cannot show buttons` };
    }
    const answer = await this.askButtons(
      platform,
      address,
      composePermissionPrompt(request.title, DEFAULT_ASK_TIMEOUT_MS, request.detail),
      request.options.map((o) => o.label),
      DEFAULT_ASK_TIMEOUT_MS,
      conversationId,
      {
        acceptsText: false,
        timeoutNote: '⏱ Nobody answered — declined. The agent was told no one answered, not that you refused.',
      }
    );
    if (answer === null) return { kind: 'cancelled' };
    if (answer.kind === 'timeout') return { kind: 'unanswered', waitedMs: DEFAULT_ASK_TIMEOUT_MS };
    if (answer.kind !== 'option') return { kind: 'cancelled' };
    const picked = request.options.find((o) => o.label === answer.labels[0]);
    return picked ? { kind: 'selected', optionId: picked.optionId } : { kind: 'cancelled' };
  }

  async onElicitRequest(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentElicitation
  ): Promise<ElicitAnswer> {
    const gap: ElicitGap = {
      acceptsText: request.questions.every((q) => q.customKey !== undefined),
    };
    this.elicitGaps.set(conversationId, gap);
    try {
      return await this.askRounds(conversationId, platform, address, request);
    } finally {
      this.elicitGaps.delete(conversationId);
      if (gap.parked !== undefined) {
        console.warn(`[ask] ${conversationId}: a parked answer was never delivered: ${gap.parked}`);
      }
    }
  }

  private async askRounds(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentElicitation
  ): Promise<ElicitAnswer> {
    const content: Record<string, string | string[]> = {};
    for (const [i, q] of request.questions.entries()) {
      const multi = canMultiSelect(platform, q);
      const answer = await this.askButtons(
        platform,
        address,
        composeElicitPrompt(
          q,
          i,
          request.questions.length,
          q.multi && !multi ? MULTI_DEGRADED_NOTE : undefined
        ),
        q.options.map((o) => o.label),
        DEFAULT_ASK_TIMEOUT_MS,
        conversationId,
        { acceptsText: q.customKey !== undefined, multi }
      );
      if (answer === null || answer.kind === 'timeout') {
        console.log(`[elicit] ${conversationId}: question ${i + 1} went unanswered; cancelling`);
        return { action: 'cancel' };
      }
      if (answer.kind === 'text') {
        content[q.customKey!] = answer.text;
        continue;
      }
      const picked = answer.labels.map((l) => q.options.find((o) => o.label === l)?.value);
      if (picked.some((v) => v === undefined)) return { action: 'cancel' };
      const values = picked as string[];
      content[q.key] = q.multi ? values : values[0]!;
    }
    return { action: 'accept', content };
  }

  onButton(ev: ButtonInteraction): void {
    if (this.ctx.voice.onClick(ev)) return;
    const model = parseModelButtonId(ev.buttonId);
    if (model) {
      this.onModelClick(ev, model);
      return;
    }
    const effort = parseEffortButtonId(ev.buttonId);
    if (effort) {
      void this.onEffortClick(ev, effort);
      return;
    }
    const workdir = parseWorkdirButtonId(ev.buttonId);
    if (workdir) {
      this.onWorkdirClick(ev, workdir);
      return;
    }
    const agentClick = parseAgentButtonId(ev.buttonId);
    if (agentClick) {
      this.onAgentClick(ev, agentClick);
      return;
    }
    const retry = parseRetryButtonId(ev.buttonId);
    if (retry) {
      this.onRetryClick(ev, retry);
      return;
    }
    const setting = parseSettingButtonId(ev.buttonId);
    if (setting) {
      this.onSettingClick(ev, setting);
      return;
    }
    const schedule = parseScheduleButtonId(ev.buttonId);
    if (schedule) {
      this.onScheduleClick(ev, schedule);
      return;
    }
    const pick = parsePickButtonId(ev.buttonId);
    if (pick) {
      this.onPickClick(ev, pick);
      return;
    }
    const parsed = parseAskButtonId(ev.buttonId);
    if (!parsed) return;
    const pending = this.pendingAsks.get(parsed.reqId);
    if (!pending) return;
    this.onAskClick(parsed.reqId, parsed.index, pending);
  }

  private onAskClick(reqId: string, index: number, pending: PendingAsk): void {
    const { labels, selected } = pending;
    if (!selected) {
      if (index >= labels.length) return;
      const label = labels[index]!;
      this.settleAsk(reqId, { kind: 'option', labels: [label] }, `→ Selected: ${label}`);
      return;
    }
    if (index > labels.length) return;
    if (index < labels.length) {
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
      this.redrawAsk(reqId, pending);
      return;
    }
    if (selected.size === 0) {
      this.redrawAsk(reqId, pending, MULTI_EMPTY_NOTE);
      return;
    }
    const chosen = [...selected].sort((a, b) => a - b).map((i) => labels[i]!);
    this.settleAsk(reqId, { kind: 'option', labels: chosen }, `→ Selected: ${chosen.join(', ')}`);
  }

  private redrawAsk(reqId: string, pending: PendingAsk, note?: string): void {
    const body = `${pending.prompt}\n\n${MULTI_HINT}${note ? `\n${note}` : ''}`;
    void pending.adapter
      .editButtons(pending.ref, body, buildAskButtons(reqId, pending.labels, pending.selected))
      .catch((err) =>
        console.warn(
          `[ask] ${pending.conversationId ?? reqId}: failed to repaint the selection:`,
          err instanceof Error ? err.message : err
        )
      );
  }

  // ───────────────────── harness picker ─────────────────────

  onPickerRequest(conversationId: ConversationId, agentId: string, msg: InboundMessage): void {
    const adapter = this.ctx.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    const address = addressOf(msg.conversation);
    const send = (text: string): void => {
      void adapter
        .sendMessage(address, text)
        .catch((e) => console.error('[picker] reply failed:', e instanceof Error ? e.message : e));
    };

    const def = findAgent(this.ctx.config, agentId);
    const label = agentDisplayName(def, agentId);
    const cmd = harnessCommandName(def?.harness) ?? label;
    const reported = this.agentCommands.get(agentId);
    if (!reported || reported.length === 0) {
      send(
        `▸ this conversation is now answered by ${label}.\nNo command list from it yet — send it a message first, then /${cmd} again.`
      );
      return;
    }

    const generic = genericNativeNames(def?.harness);
    const offered = reported.filter((c) => !generic.has(c.name) && agentCommandToSpec(c) !== null);
    if (offered.length === 0) {
      send(`${label} reports no commands beyond the ones already in the menu.`);
      return;
    }

    const shown = offered.slice(0, PICKER_BUTTON_MAX);
    const overflow = offered.slice(PICKER_BUTTON_MAX);
    this.retirePicksFor(conversationId);
    const reqId = randomUUID().slice(0, 8);
    this.pendingPicks.set(reqId, {
      conversationId,
      names: shown.map((c) => c.name),
      conversation: msg.conversation,
    });

    let prompt = `${label} commands:`;
    if (overflow.length > 0) {
      prompt += `\n\n${overflow.length} more (type them directly): ${overflow.map((c) => `/${c.name}`).join(', ')}`;
    }
    const buttons = shown.map((c, i) => ({ id: `${PICK_PREFIX}${reqId}:${i}`, label: `/${c.name}` }));
    void adapter
      .sendButtons(address, prompt, buttons)
      .then((ref) => {
        const pending = this.pendingPicks.get(reqId);
        if (pending) pending.ref = ref;
      })
      .catch((e) => {
        this.pendingPicks.delete(reqId);
        console.error('[picker] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private retirePicksFor(conversationId: ConversationId): void {
    for (const [reqId, pick] of this.pendingPicks) {
      if (pick.conversationId !== conversationId) continue;
      this.pendingPicks.delete(reqId);
      const adapter = this.ctx.platforms.get(pick.conversation.platform);
      if (!adapter || !pick.ref) continue;
      void adapter
        .editButtons(pick.ref, 'This menu was replaced by a newer one.', [])
        .catch((e) => console.warn('[picker] menu edit failed:', e instanceof Error ? e.message : e));
    }
  }

  private onPickClick(ev: ButtonInteraction, parsed: { reqId: string; index: number }): void {
    const pick = this.pendingPicks.get(parsed.reqId);
    if (!pick) {
      console.log(`[picker] click on an expired menu (${parsed.reqId})`);
      void this.ctx.platforms
        .get(ev.conversation.platform)
        ?.sendMessage(
          addressOf(ev.conversation),
          'That menu has expired (already used, replaced by a newer one, or the gateway restarted). Re-open it with the agent command (`/oc`, `/cc`, …), or /help for the full list.'
        )
        .catch(() => undefined);
      return;
    }
    const name = pick.names[parsed.index];
    if (name === undefined) return;

    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied picker click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    this.pendingPicks.delete(parsed.reqId);
    const platformId = pick.conversation.platform;
    const address = addressOf(pick.conversation);
    const delivered = this.ctx.registry.dispatchTo(pick.conversationId, {
      conversation: { ...pick.conversation, user: clicker.user },
      messageId: ev.messageId,
      content: `/${name}`,
      timestamp: Date.now(),
      mentionedSelf: true,
    });
    if (!delivered) {
      void this.ctx.platforms
        .get(platformId)
        ?.sendMessage(address, `That conversation is gone — send a message first, then run /${name}.`)
        .catch(() => undefined);
      return;
    }
    const ackRef = pick.ref ?? { address, messageId: ev.messageId };
    void this.ctx.platforms
      .get(platformId)
      ?.editMessage(ackRef, `→ /${name}`)
      .catch((e) => console.warn('[picker] click ack edit failed:', e instanceof Error ? e.message : e));
  }

  // ───────────────────── /model menu ─────────────────────

  onModelMenuRequest(
    conversationId: ConversationId,
    agentId: string,
    msg: InboundMessage,
    selector: ModelSelector
  ): void {
    const adapter = this.ctx.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    this.retireModelMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    const options = [...selector.options];
    const pageSize = resolvePageSize(adapter.capabilities.menuPageSize);
    const pending: PendingModelMenu = {
      conversationId,
      agentId,
      conversation: msg.conversation,
      options,
      current: selector.current,
      pageSize,
    };
    this.pendingModelMenus.set(reqId, pending);

    const index = modelIndexOf(options, selector.current);
    const view = buildModelMenu({
      reqId,
      options,
      current: selector.current,
      page: index >= 0 ? modelPageOf(index, pageSize) : 0,
      pageSize,
    });
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingModelMenus.delete(reqId);
        console.error('[model] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private retireModelMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingModelMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingModelMenus.delete(reqId);
      this.editModelMenu(menu, modelMenuSupersededText(menu.current), []);
    }
  }

  private editModelMenu(
    menu: PendingModelMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.ctx.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[model] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[model] menu edit failed:', e instanceof Error ? e.message : e));
  }

  private onModelClick(ev: ButtonInteraction, click: ModelButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied model-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingModelMenus.get(click.reqId);
    if (!menu) {
      console.log(`[model] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, modelMenuExpiredText());
      return;
    }

    if (click.kind === 'page') {
      const view = buildModelMenu({
        reqId: click.reqId,
        options: menu.options,
        current: menu.current,
        page: click.page,
        pageSize: menu.pageSize,
      });
      this.editModelMenu(menu, view.text, view.buttons);
      return;
    }
    void this.onModelPickClick(ev, click.reqId, menu, click.index);
  }

  private async onModelPickClick(
    ev: ButtonInteraction,
    reqId: string,
    menu: PendingModelMenu,
    index: number
  ): Promise<void> {
    const option = menu.options[index];
    if (!option) {
      console.warn(`[model] click index ${index} is outside the menu's ${menu.options.length} options`);
      this.replyToClick(ev, modelMenuExpiredText());
      return;
    }

    const result = await this.ctx.registry.applyModelChoice(menu.conversationId, menu.agentId, option.value);
    const text = modelChoiceText(result);
    console.log(`[model] ${menu.conversationId}: ${option.value} → ${result.kind}`);

    const retire =
      result.kind === 'applied' ||
      result.kind === 'gone' ||
      result.kind === 'rebound' ||
      result.kind === 'missing';
    if (retire) {
      this.pendingModelMenus.delete(reqId);
      this.editModelMenu(menu, text, []);
      return;
    }
    const view = buildModelMenu({
      reqId,
      options: menu.options,
      current: menu.current,
      page: modelPageOf(index, menu.pageSize),
      pageSize: menu.pageSize,
    });
    this.editModelMenu(menu, `${view.text}\n\n${text}`, view.buttons);
  }

  private replyToClick(ev: ButtonInteraction, text: string): void {
    void this.ctx.platforms
      .get(ev.conversation.platform)
      ?.sendMessage(addressOf(ev.conversation), text)
      .catch((e) => console.warn('[menu] failed to answer a click:', e instanceof Error ? e.message : e));
  }

  // ───────────────────── /effort menu ─────────────────────

  onEffortMenuRequest(
    conversationId: ConversationId,
    agentId: string,
    msg: InboundMessage,
    selector: EffortSelector
  ): void {
    const adapter = this.ctx.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    this.retireEffortMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    const options = [...selector.options];
    const pending: PendingEffortMenu = {
      conversationId,
      agentId,
      conversation: msg.conversation,
      options,
      current: selector.current,
    };
    this.pendingEffortMenus.set(reqId, pending);

    const view = buildEffortMenu({ reqId, options, current: selector.current });
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingEffortMenus.delete(reqId);
        console.error('[effort] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private retireEffortMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingEffortMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingEffortMenus.delete(reqId);
      this.editEffortMenu(menu, effortMenuSupersededText(menu.current), []);
    }
  }

  private editEffortMenu(
    menu: PendingEffortMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.ctx.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[effort] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[effort] menu edit failed:', e instanceof Error ? e.message : e));
  }

  private async onEffortClick(ev: ButtonInteraction, click: EffortButtonClick): Promise<void> {
    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied effort-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingEffortMenus.get(click.reqId);
    const option = menu?.options[click.index];
    if (!menu || !option) {
      console.log(`[effort] click on an expired menu (${click.reqId}:${click.index})`);
      this.replyToClick(ev, effortMenuExpiredText());
      return;
    }

    const result = await this.ctx.registry.applyEffortChoice(menu.conversationId, menu.agentId, option.value);
    const text = effortChoiceText(result);
    console.log(`[effort] ${menu.conversationId}: ${option.value} → ${result.kind}`);

    if (result.kind !== 'failed') {
      this.pendingEffortMenus.delete(click.reqId);
      this.editEffortMenu(menu, text, []);
      return;
    }
    const view = buildEffortMenu({ reqId: click.reqId, options: menu.options, current: menu.current });
    this.editEffortMenu(menu, `${view.text}\n\n${text}`, view.buttons);
  }

  // ───────────────────── /cd workdir menu ─────────────────────

  onWorkdirMenuRequest(
    conversationId: ConversationId,
    agentId: string,
    conv: ConversationRef,
    menu: { options: WorkdirOption[]; current: string; truncated: number }
  ): void {
    const adapter = this.ctx.platforms.get(conv.platform);
    if (!adapter) return;
    this.retireWorkdirMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    const options = [...menu.options];
    const pageSize = resolvePageSize(
      adapter.capabilities.workdirPageSize ?? adapter.capabilities.menuPageSize,
      WORKDIR_PAGE_SIZE_MAX
    );
    const pending: PendingWorkdirMenu = {
      conversationId,
      agentId,
      conversation: conv,
      options,
      current: menu.current,
      pageSize,
    };
    this.pendingWorkdirMenus.set(reqId, pending);

    const index = workdirIndexOf(options, menu.current);
    const view = buildWorkdirMenu({
      reqId,
      options,
      current: menu.current,
      page: index >= 0 ? workdirPageOf(index, pageSize) : 0,
      pageSize,
    });
    const text =
      menu.truncated > 0
        ? `${view.text}\n(+${menu.truncated} more not shown — type part of a name instead.)`
        : view.text;
    void adapter
      .sendButtons(addressOf(conv), text, view.buttons)
      .then((ref) => {
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingWorkdirMenus.delete(reqId);
        console.error('[workdir] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private retireWorkdirMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingWorkdirMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingWorkdirMenus.delete(reqId);
      this.editWorkdirMenu(menu, workdirMenuSupersededText(menu.current), []);
    }
  }

  private editWorkdirMenu(
    menu: PendingWorkdirMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.ctx.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[workdir] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[workdir] menu edit failed:', e instanceof Error ? e.message : e));
  }

  private onWorkdirClick(ev: ButtonInteraction, click: WorkdirButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied workdir-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingWorkdirMenus.get(click.reqId);
    if (!menu) {
      console.log(`[workdir] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, workdirMenuExpiredText());
      return;
    }

    if (click.kind === 'page') {
      const view = buildWorkdirMenu({
        reqId: click.reqId,
        options: menu.options,
        current: menu.current,
        page: click.page,
        pageSize: menu.pageSize,
      });
      this.editWorkdirMenu(menu, view.text, view.buttons);
      return;
    }

    const option = menu.options[click.index];
    if (!option) {
      console.warn(`[workdir] click index ${click.index} is outside the menu's ${menu.options.length} options`);
      this.replyToClick(ev, workdirMenuExpiredText());
      return;
    }

    const result = this.ctx.registry.applyWorkdirChoice(menu.conversationId, menu.agentId, option.path);
    const text = workdirChoiceText(result);
    console.log(`[workdir] ${menu.conversationId}: ${option.path} → ${result.kind}`);

    if (result.kind === 'failed') {
      const view = buildWorkdirMenu({
        reqId: click.reqId,
        options: menu.options,
        current: menu.current,
        page: workdirPageOf(click.index, menu.pageSize),
        pageSize: menu.pageSize,
      });
      this.editWorkdirMenu(menu, `${view.text}\n\n${text}`, view.buttons);
      return;
    }
    this.pendingWorkdirMenus.delete(click.reqId);
    this.editWorkdirMenu(menu, text, []);
  }

  // ───────────────────── Retry & /agent menu ─────────────────────

  private onRetryClick(ev: ButtonInteraction, click: RetryButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied retry click from ${clicker.platform}:${clicker.user}`);
      return;
    }
    if (click.mode === 'same') {
      this.runRetry(click.retryId, clicker.user, undefined, (text) => this.replyToClick(ev, text));
      return;
    }
    if (click.mode === 'reconnect') {
      this.runRetry(click.retryId, clicker.user, undefined, (text) => this.replyToClick(ev, text), true);
      return;
    }
    const record = this.ctx.registry.retryRecord(click.retryId);
    if (!record) {
      this.replyToClick(ev, 'Nothing to retry any more — a later turn has run since, or this one was already retried.');
      return;
    }
    const groups = agentGroups(this.ctx.config.agents, this.ctx.offlineNames());
    this.onAgentMenuRequest(record.conversation, clicker, { groups, current: record.agentId }, click.retryId);
  }

  private runRetry(retryId: string, user: string, agentId: string | undefined, say: (text: string) => void, reconnect = false): void {
    this.ctx.registry
      .retryTurn({ retryId, user, ...(agentId ? { agentId } : {}), ...(reconnect ? { reconnect: true } : {}) })
      .then((r) => say(r.text))
      .catch((e) => {
        console.error('[retry] failed:', e instanceof Error ? e.message : e);
        say(`Could not retry: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  onAgentMenuRequest(
    conversationId: ConversationId,
    conversation: ConversationRef,
    menu: { groups: AgentGroup[]; current: string | undefined },
    retry?: string
  ): void {
    const adapter = this.ctx.platforms.get(conversation.platform);
    if (!adapter) return;
    for (const [reqId, old] of this.pendingAgentMenus) {
      if (old.conversationId !== conversationId) continue;
      this.pendingAgentMenus.delete(reqId);
      this.editAgentMenu(old, 'This menu was replaced by a newer one.', []);
    }
    const reqId = randomUUID().slice(0, 8);
    const pending: PendingAgentMenu = {
      conversationId,
      conversation,
      groups: menu.groups.map((g) => ({ ...g, agents: [...g.agents] })),
      current: menu.current,
      pageSize: resolvePageSize(adapter.capabilities.menuPageSize),
      ...(retry ? { retry } : {}),
    };
    this.pendingAgentMenus.set(reqId, pending);
    const view = buildAgentMenu({
      reqId,
      groups: pending.groups,
      current: pending.current,
      pageSize: pending.pageSize,
      ...(retry ? { purpose: 'retry' as const } : {}),
    });
    void adapter
      .sendButtons(addressOf(conversation), view.text, view.buttons)
      .then((ref) => {
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingAgentMenus.delete(reqId);
        console.error('[agent] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private editAgentMenu(menu: PendingAgentMenu, text: string, buttons: Array<{ id: string; label: string }>): void {
    const adapter = this.ctx.platforms.get(menu.conversation.platform);
    if (!adapter || !menu.ref) return;
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[agent] menu edit failed:', e instanceof Error ? e.message : e));
  }

  private onAgentClick(ev: ButtonInteraction, click: AgentButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied agent-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }
    const menu = this.pendingAgentMenus.get(click.reqId);
    if (!menu) {
      this.replyToClick(ev, 'That menu has expired — send /agent again.');
      return;
    }
    const render = (group?: number, page?: number): void => {
      const view = buildAgentMenu({
        reqId: click.reqId,
        groups: menu.groups,
        current: menu.current,
        group,
        page,
        pageSize: menu.pageSize,
        ...(menu.retry ? { purpose: 'retry' as const } : {}),
      });
      this.editAgentMenu(menu, view.text, view.buttons);
    };
    if (click.kind === 'group') return render(click.group);
    if (click.kind === 'back') return render();
    if (click.kind === 'page') return render(click.group, click.page);
    const def = flatAgents(menu.groups)[click.index];
    this.pendingAgentMenus.delete(click.reqId);
    if (menu.retry) {
      if (!def) return this.editAgentMenu(menu, 'That agent is no longer configured.', []);
      this.runRetry(menu.retry, clicker.user, def.id, (text) => this.editAgentMenu(menu, text, []));
      return;
    }
    const text = def
      ? this.ctx.registry.chooseAgent(menu.conversationId, def.id, menu.conversation)
      : 'That agent is no longer configured.';
    this.editAgentMenu(menu, text, []);
    if (def) this.ctx.registry.offerPlacement(menu.conversationId, def.id, menu.conversation);
  }

  // ───────────────────── /setting menu ─────────────────────

  onSettingMenuRequest(
    conversationId: ConversationId,
    msg: InboundMessage,
    menu: {
      rows: SettingRow[];
      open?: { row: SettingRow; options: SettingOption[]; hint?: string };
      asking?: Promise<unknown>;
    }
  ): void {
    const adapter = this.ctx.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    this.retireSettingsMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    const pending: PendingSettingsMenu = {
      conversationId,
      conversation: msg.conversation,
      rows: [...menu.rows],
      pageSize: resolvePageSize(adapter.capabilities.menuPageSize),
      ...(menu.open ? { open: { ...menu.open, options: [...menu.open.options] } } : {}),
    };
    this.pendingSettingsMenus.set(reqId, pending);

    const view = this.renderSettingsMenu(reqId, pending);
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons, view.screen)
      .then((ref) => {
        pending.ref = ref;
        if (menu.asking) this.whenModelsArrive(reqId, pending, menu.asking);
      })
      .catch((e) => {
        this.pendingSettingsMenus.delete(reqId);
        console.error('[setting] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private renderSettingsMenu(
    reqId: string,
    menu: PendingSettingsMenu,
    page = 0,
    ack?: SettingsAck
  ): { text: string; buttons: Array<{ id: string; label: string }>; screen?: SettingsScreen } {
    const wantsScreen =
      this.ctx.platforms.get(menu.conversation.platform)?.capabilities.settingsScreen === true;
    const notice = ack ? { tone: ack.tone, text: ack.text } : undefined;
    const open = menu.open;
    const view = open
      ? buildSettingValueMenu({
          reqId,
          row: open.row,
          options: open.options,
          page: wantsScreen ? 0 : page,
          pageSize: wantsScreen ? Math.max(1, open.options.length) : menu.pageSize,
          ...(open.hint ? { hint: open.hint } : {}),
          ...(wantsScreen ? { screen: this.valueScreenInput(open.row, notice) } : {}),
        })
      : buildSettingsMenu({
          reqId,
          rows: menu.rows,
          ...(this.ctx.schedules
            ? { extra: { id: scheduleOpenButtonId(reqId), label: scheduleEntryLabel(this.ctx.schedules.tasks()) } }
            : {}),
          ...(wantsScreen ? { screen: this.listScreenInput(menu, notice) } : {}),
        });
    if (!menu.open) {
      if (view.choices) menu.choices = view.choices;
      else delete menu.choices;
    }
    return {
      text: ack ? `${ack.text}\n\n${view.text}` : view.text,
      buttons: view.buttons,
      ...(view.screen ? { screen: view.screen } : {}),
    };
  }

  private listScreenInput(menu: PendingSettingsMenu, notice?: SettingsAck): SettingsScreenInput {
    return {
      cfg: this.ctx.config,
      options: (row: SettingRow) => this.ctx.registry.settingOptionsFor(menu.conversationId, row, false).options,
      here: this.ctx.registry.settingsBoundAgent(menu.conversationId),
      ...(notice ? { notice } : {}),
    };
  }

  private valueScreenInput(row: SettingRow, notice?: SettingsAck): { cfg: Config; notice?: SettingsAck; loading?: boolean } {
    const listAgent = modelListAgent(row, this.ctx.config);
    const loading = listAgent !== undefined && this.ctx.registry.modelListLoading(listAgent);
    return { cfg: this.ctx.config, ...(notice ? { notice } : {}), ...(loading ? { loading } : {}) };
  }

  private retireSettingsMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingSettingsMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingSettingsMenus.delete(reqId);
      this.editSettingsMenu(menu, settingsMenuSupersededText(), []);
    }
    for (const [reqId, menu] of this.pendingScheduleMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingScheduleMenus.delete(reqId);
      this.editMenuMessage(menu, settingsMenuSupersededText(), []);
    }
  }

  private editSettingsMenu(
    menu: PendingSettingsMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>,
    screen?: SettingsScreen
  ): void {
    this.editMenuMessage(menu, text, buttons, screen);
  }

  private editMenuMessage(
    menu: { conversation: ConversationRef; ref?: MessageRef },
    text: string,
    buttons: Array<{ id: string; label: string }>,
    screen?: SettingsScreen
  ): void {
    const adapter = this.ctx.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[setting] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons, screen)
      .catch((e) => console.warn('[setting] menu edit failed:', e instanceof Error ? e.message : e));
  }

  private onSettingClick(ev: ButtonInteraction, click: SettingButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied settings-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingSettingsMenus.get(click.reqId);
    if (!menu) {
      console.log(`[setting] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, settingsMenuExpiredText());
      return;
    }

    switch (click.kind) {
      case 'open':
        this.openSettingLevel(click.reqId, menu, click.index);
        return;
      case 'choose':
        this.chooseSettingValue(click.reqId, menu, click.index);
        return;
      case 'set':
        this.setSettingFromList(click.reqId, menu, click.index);
        return;
      case 'type':
        this.typeSettingValue(click.reqId, menu, ev.value);
        return;
      case 'page':
        this.editSettingsMenu(menu, ...this.viewParts(click.reqId, menu, click.page));
        return;
      case 'back':
        delete menu.open;
        menu.rows = this.ctx.registry.settingRows();
        this.editSettingsMenu(menu, ...this.viewParts(click.reqId, menu));
        return;
      default: {
        const _exhaustive: never = click;
        throw new Error(`unknown settings click: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private viewParts(
    reqId: string,
    menu: PendingSettingsMenu,
    page = 0,
    ack?: SettingsAck
  ): [string, Array<{ id: string; label: string }>, SettingsScreen?] {
    const view = this.renderSettingsMenu(reqId, menu, page, ack);
    return [view.text, view.buttons, view.screen];
  }

  private openSettingLevel(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const frozen = menu.rows[index];
    if (!frozen) {
      console.warn(`[setting] click index ${index} is outside the menu's ${menu.rows.length} rows`);
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu));
      return;
    }
    const rows = this.ctx.registry.settingRows();
    const row = rows.find((r) => r.id === frozen.id && r.target === frozen.target) ?? frozen;
    const { options, hint, asking } = this.ctx.registry.settingOptionsFor(menu.conversationId, row);
    menu.rows = rows;
    menu.open = { row, options, ...(hint ? { hint } : {}) };
    this.editSettingsMenu(
      menu,
      ...this.viewParts(reqId, menu, settingValuePage(row, options, menu.pageSize))
    );
    if (asking) this.whenModelsArrive(reqId, menu, asking);
  }

  private whenModelsArrive(reqId: string, menu: PendingSettingsMenu, asking: Promise<unknown>): void {
    const row = menu.open?.row;
    void asking.then(() => {
      const open = menu.open;
      if (this.pendingSettingsMenus.get(reqId) !== menu || !open || !row) return;
      if (open.row.id !== row.id || open.row.target !== row.target) return;
      const { options, hint } = this.ctx.registry.settingOptionsFor(menu.conversationId, open.row, false);
      menu.open = { row: open.row, options, ...(hint ? { hint } : {}) };
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, settingValuePage(open.row, options, menu.pageSize)));
    });
  }

  private typeSettingValue(reqId: string, menu: PendingSettingsMenu, value: string | undefined): void {
    const open = menu.open;
    if (!open) {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, expiredAck()));
      return;
    }
    const typed = value?.trim();
    if (!typed) {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, { tone: 'error', text: 'Type a value first.' }));
      return;
    }
    const result = this.ctx.registry.applySetting(menu.conversationId, open.row, typed);
    console.log(`[setting] ${menu.conversationId}: ${open.row.label} ← typed "${typed}" → ${result.kind}`);
    if (result.kind !== 'saved') {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, settingNotice(result)));
      return;
    }
    delete menu.open;
    menu.rows = this.ctx.registry.settingRows();
    this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, settingNotice(result)));
  }

  private chooseSettingValue(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const open = menu.open;
    if (!open) {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu));
      return;
    }
    const option = open.options[index];
    if (!option) {
      console.warn(`[setting] value index ${index} is outside ${open.options.length} options`);
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, expiredAck()));
      return;
    }

    const result = this.ctx.registry.applySetting(menu.conversationId, open.row, option.raw);
    const ack = settingNotice(result);
    console.log(`[setting] ${menu.conversationId}: ${open.row.label} ← ${option.raw} → ${result.kind}`);

    if (result.kind !== 'saved') {
      this.editSettingsMenu(
        menu,
        ...this.viewParts(reqId, menu, settingValuePage(open.row, open.options, menu.pageSize), ack)
      );
      return;
    }
    delete menu.open;
    menu.rows = this.ctx.registry.settingRows();
    this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, ack));
  }

  private setSettingFromList(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const choice = menu.open ? undefined : menu.choices?.[index];
    const frozen = choice ? menu.rows[choice.row] : undefined;
    if (!choice || !frozen) {
      console.warn(`[setting] list choice ${index} does not match the screen on this menu`);
      delete menu.open;
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, expiredAck()));
      return;
    }
    const row =
      this.ctx.registry.settingRows().find((r) => r.id === frozen.id && r.target === frozen.target) ?? frozen;
    const result = this.ctx.registry.applySetting(menu.conversationId, row, choice.raw);
    console.log(`[setting] ${menu.conversationId}: ${row.label} ← ${choice.raw} → ${result.kind}`);
    menu.rows = this.ctx.registry.settingRows();
    this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, settingNotice(result)));
  }

  // ───────────────────── scheduled tasks under /setting ─────────────────────

  onScheduleSetting(id: ConversationId, msg: InboundMessage, args: string[], canMenu: boolean): void {
    const adapter = this.ctx.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    const reply = (text: string): void =>
      void adapter
        .sendMessage(addressOf(msg.conversation), text)
        .catch((e) => console.warn('[schedule] reply failed:', e instanceof Error ? e.message : e));
    if (!this.ctx.schedules) {
      reply('Scheduled tasks are not enabled in this gateway.');
      return;
    }
    const [verb, rawId] = args;
    if (!verb) {
      if (canMenu) this.postScheduleMenu(id, msg, adapter);
      else
        reply(
          `${taskListText(this.ctx.schedules.tasks(), this.ctx.schedules.now())}\n\nManage one with \`/setting schedule pause|resume|delete|run <id>\`.`
        );
      return;
    }
    const op = SCHEDULE_TYPED_OPS[verb.toLowerCase()];
    if (!op || !rawId) {
      reply('Usage: `/setting schedule` to list, or `/setting schedule pause|resume|delete|run <id>`.');
      return;
    }
    try {
      const view = this.ctx.schedules.op(rawId.replace(/^#/, ''), op, id);
      if (op === 'run') reply(`⏰ Running \`#${view.id}\` **${view.name}** now.`);
    } catch (e) {
      reply(e instanceof Error ? e.message : String(e));
    }
  }

  private postScheduleMenu(conversationId: ConversationId, msg: InboundMessage, adapter: PlatformAdapter): void {
    this.retireSettingsMenusFor(conversationId);
    const reqId = randomUUID().slice(0, 8);
    const menu: PendingScheduleMenu = {
      conversationId,
      conversation: msg.conversation,
      ids: [],
      pageSize: resolvePageSize(adapter.capabilities.menuPageSize),
    };
    this.pendingScheduleMenus.set(reqId, menu);
    const view = this.renderScheduleMenu(reqId, menu);
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        menu.ref = ref;
      })
      .catch((e) => {
        this.pendingScheduleMenus.delete(reqId);
        console.error('[schedule] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private renderScheduleMenu(
    reqId: string,
    menu: PendingScheduleMenu,
    prefix?: string
  ): { text: string; buttons: Array<{ id: string; label: string }> } {
    const schedules = this.ctx.schedules!;
    const now = schedules.now();
    const withPrefix = (v: { text: string; buttons: Array<{ id: string; label: string }> }) => ({
      text: prefix ? `${prefix}\n\n${v.text}` : v.text,
      buttons: v.buttons,
    });
    if (menu.open) {
      const task = schedules.get(menu.open.id);
      if (task) {
        return withPrefix(
          menu.open.confirm ? buildScheduleDeleteConfirm(reqId, task) : buildScheduleTaskMenu(reqId, task, now)
        );
      }
      prefix = `\`#${menu.open.id}\` no longer exists.${prefix ? ` ${prefix}` : ''}`;
      delete menu.open;
    }
    const list = buildScheduleListMenu(reqId, schedules.tasks(), now);
    menu.ids = list.ids;
    return withPrefix(list);
  }

  private onScheduleClick(ev: ButtonInteraction, click: ScheduleMenuClick): void {
    const clicker = ev.conversation;
    const allow = this.ctx.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied schedule-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }
    if (!this.ctx.schedules) return;

    if (click.kind === 'open') {
      const settings = this.pendingSettingsMenus.get(click.reqId);
      if (!settings) {
        this.replyToClick(ev, scheduleMenuExpiredText());
        return;
      }
      this.pendingSettingsMenus.delete(click.reqId);
      const menu: PendingScheduleMenu = {
        conversationId: settings.conversationId,
        conversation: settings.conversation,
        ids: [],
        pageSize: settings.pageSize,
        ...(settings.ref ? { ref: settings.ref } : {}),
      };
      this.pendingScheduleMenus.set(click.reqId, menu);
      this.editMenuMessage(menu, ...this.scheduleParts(click.reqId, menu));
      return;
    }

    const menu = this.pendingScheduleMenus.get(click.reqId);
    if (!menu) {
      this.replyToClick(ev, scheduleMenuExpiredText());
      return;
    }
    if (click.kind === 'task') {
      const id = menu.ids[click.index];
      if (id) menu.open = { id, confirm: false };
      this.editMenuMessage(menu, ...this.scheduleParts(click.reqId, menu));
      return;
    }
    this.onScheduleAction(click.reqId, menu, click.action);
  }

  private onScheduleAction(reqId: string, menu: PendingScheduleMenu, action: ScheduleMenuAction): void {
    const schedules = this.ctx.schedules!;
    const open = menu.open;
    let ack: string | undefined;
    switch (action) {
      case 'settings': {
        this.pendingScheduleMenus.delete(reqId);
        const settings: PendingSettingsMenu = {
          conversationId: menu.conversationId,
          conversation: menu.conversation,
          rows: this.ctx.registry.settingRows(),
          pageSize: menu.pageSize,
          ...(menu.ref ? { ref: menu.ref } : {}),
        };
        this.pendingSettingsMenus.set(reqId, settings);
        this.editSettingsMenu(settings, ...this.viewParts(reqId, settings));
        return;
      }
      case 'back':
        if (open?.confirm) open.confirm = false;
        else delete menu.open;
        break;
      case 'delete':
        if (open) open.confirm = true;
        break;
      case 'pause':
      case 'resume':
      case 'confirm-delete': {
        if (!open) break;
        const op = action === 'confirm-delete' ? 'remove' : action;
        try {
          const view = schedules.op(open.id, op, menu.conversationId, false);
          ack = `${op === 'remove' ? '🗑 Deleted' : op === 'pause' ? '⏸ Paused' : '▶ Resumed'} \`#${view.id}\` **${view.name}**.`;
          if (op === 'remove') delete menu.open;
        } catch (e) {
          ack = e instanceof Error ? e.message : String(e);
          open.confirm = false;
        }
        console.log(`[schedule] ${menu.conversationId}: ${op} #${open.id} from the menu`);
        break;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown schedule action: ${JSON.stringify(_exhaustive)}`);
      }
    }
    this.editMenuMessage(menu, ...this.scheduleParts(reqId, menu, ack));
  }

  private scheduleParts(
    reqId: string,
    menu: PendingScheduleMenu,
    prefix?: string
  ): [string, Array<{ id: string; label: string }>] {
    const view = this.renderScheduleMenu(reqId, menu, prefix);
    return [view.text, view.buttons];
  }
}

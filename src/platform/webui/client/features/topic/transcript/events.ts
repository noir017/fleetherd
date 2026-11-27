import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { post } from '../../../services/api.js';
import { handleToolbarKeydown } from './message-actions.js';
import type { TranscriptTopicLike } from './types.js';

export type PostClickFn = (
  url: string,
  body: Record<string, unknown>,
  retries: number,
) => Promise<{ readonly ok: boolean }>;

export function postButton(
  b: HTMLButtonElement,
  topicId: string,
  postFn: PostClickFn = post,
): void {
  b.disabled = true;
  b.classList.add('busy');
  postFn(
    'api/click',
    {
      topic: topicId,
      messageId: b.getAttribute('data-msg'),
      buttonId: b.getAttribute('data-btn'),
    },
    2,
  )
    .then((r) => {
      if (!r.ok) b.classList.remove('busy');
    })
    .catch(() => {
      b.disabled = false;
      b.classList.remove('busy');
    });
}

export function filterWorkdirPicker(inputEl: HTMLInputElement): void {
  const box = inputEl.closest('.wd-picker');
  if (!box) return;
  const needle = String(inputEl.value || '')
    .trim()
    .toLowerCase();
  const rows = box.querySelectorAll<HTMLElement>('.wd-row');
  let shown = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const match = !needle || String(row.getAttribute('data-wd-name') || '').indexOf(needle) !== -1;
    row.hidden = !match;
    if (match) shown++;
  }
  const empty = box.querySelector<HTMLElement>('.wd-filter-empty');
  if (empty) empty.hidden = shown > 0;
}

export interface LogEventsDeps {
  readonly getTopic: () => string;
  readonly getTopics: () => readonly TranscriptTopicLike[];
  readonly isNarrow: () => boolean;
  readonly setSidebar: (open: boolean) => void;
  readonly switchTopic: (id: string) => void;
  readonly openShot: (img: HTMLImageElement) => void;
  readonly sendCommand: (cmd: string) => void;
  readonly selectLaunchAgent?: (agentId: string) => void;
  readonly browseLaunchWorkdir?: (dir: string) => void;
  readonly pickLaunchWorkdir?: (cwd: string) => void;
  readonly unfoldLaunch?: (part?: 'agents' | 'workdir') => void;
  readonly toggleBtw: (qk: string) => void;
  readonly openReader: (link: HTMLAnchorElement) => void;
  readonly deliverLocal: (nonce: string) => void;
  readonly copyLocal: (nonce: string, btn: HTMLElement) => void;
  readonly discardLocal: (nonce: string) => void;
  readonly toggleAll: (key: string) => void;
  readonly toggleLine: (line: HTMLElement) => void;
  readonly toggleCard: (key: string) => void;
  readonly openTurnChanges: (turn: number) => void;
  readonly openTurnDiffSideBySide?: (turn: number, btn: HTMLButtonElement) => void;
  readonly onMessageAction?: (action: string, key: string, btn: HTMLButtonElement) => void;
  readonly onHandoff?: (key: string, btn: HTMLButtonElement) => void;
  readonly postButton?: (btn: HTMLButtonElement, topicId: string) => void;
  readonly onLoadOlder?: () => void;
  readonly onJumpToMessage?: (msgId: string) => void;
}

function handleLocalAction(act: HTMLElement, deps: LogEventsDeps): void {
  const retry = act.getAttribute('data-retry');
  if (retry) {
    deps.deliverLocal(retry);
    return;
  }
  const copy = act.getAttribute('data-copy');
  if (copy) {
    deps.copyLocal(copy, act);
    return;
  }
  const discard = act.getAttribute('data-discard');
  if (discard) deps.discardLocal(discard);
}

function handleLaunchClick(target: Element, deps: LogEventsDeps): boolean {
  const unfold = target.closest('button[data-launch-unfold]');
  if (unfold) {
    const part = unfold.getAttribute('data-launch-unfold');
    deps.unfoldLaunch?.(part === 'agents' || part === 'workdir' ? part : undefined);
    return true;
  }
  const card = target.closest('button[data-agent]');
  if (card) {
    const agentId = card.getAttribute('data-agent');
    if (agentId) {
      if (deps.selectLaunchAgent) deps.selectLaunchAgent(agentId);
      else deps.sendCommand(`/agent ${agentId}`);
    }
    return true;
  }
  const wdBrowse = target.closest('button[data-wd-browse]');
  if (wdBrowse) {
    const dir = wdBrowse.getAttribute('data-wd-browse');
    if (dir) deps.browseLaunchWorkdir?.(dir);
    return true;
  }
  const wdPick = target.closest('button[data-wd-pick]');
  if (wdPick) {
    const cwd = wdPick.getAttribute('data-wd-pick');
    if (cwd) deps.pickLaunchWorkdir?.(cwd);
    return true;
  }
  return false;
}

function handleNavClick(target: Element, e: MouseEvent, deps: LogEventsDeps): boolean {
  const shot = target.closest('img.shot');
  if (shot) {
    deps.openShot(shot as HTMLImageElement);
    return true;
  }
  const go = target.closest('a[data-goto]');
  if (go) {
    e.preventDefault();
    const goId = go.getAttribute('data-goto');
    if (goId && deps.getTopics().some((t) => t.id === goId)) {
      deps.switchTopic(goId);
      if (deps.isNarrow()) deps.setSidebar(false);
    }
    return true;
  }
  if (handleLaunchClick(target, deps)) return true;
  const chip = target.closest('.btw-chip');
  if (chip) {
    const holder = chip.closest('[data-k]');
    const qk = holder ? holder.getAttribute('data-k') : null;
    if (qk) deps.toggleBtw(qk);
    return true;
  }
  const view = target.closest('a[data-view]');
  if (view) {
    e.preventDefault();
    deps.openReader(view as HTMLAnchorElement);
    return true;
  }
  const loadOlder = target.closest('button[data-load-older]');
  if (loadOlder) {
    deps.onLoadOlder?.();
    return true;
  }
  const jumpQuote = target.closest('[data-jump-msg]');
  if (jumpQuote) {
    const msgId = jumpQuote.getAttribute('data-jump-msg');
    if (msgId) deps.onJumpToMessage?.(msgId);
    return true;
  }
  return false;
}

function handleTurnAndHandoffClick(target: Element, deps: LogEventsDeps): boolean {
  const turns = target.closest('button[data-turns]');
  if (turns) {
    deps.openTurnChanges(Number(turns.getAttribute('data-turns')));
    return true;
  }
  const splitTurns = target.closest<HTMLButtonElement>('button[data-turns-split]');
  if (splitTurns) {
    deps.openTurnDiffSideBySide?.(Number(splitTurns.getAttribute('data-turns-split')), splitTurns);
    return true;
  }
  const handoffBtn = target.closest<HTMLButtonElement>('button[data-handoff-k]');
  if (handoffBtn) {
    const key = handoffBtn.getAttribute('data-handoff-k');
    if (key) deps.onHandoff?.(key, handoffBtn);
    return true;
  }
  return false;
}

function handleActionClick(target: Element, deps: LogEventsDeps): void {
  const msgAct = target.closest<HTMLButtonElement>('button[data-msg-act]');
  if (msgAct) {
    const action = msgAct.getAttribute('data-msg-act');
    const key = msgAct.getAttribute('data-msg-k');
    if (action && key) deps.onMessageAction?.(action, key, msgAct);
    return;
  }
  const act = target.closest('[data-retry],[data-copy],[data-discard]');
  if (act) {
    handleLocalAction(act as HTMLElement, deps);
    return;
  }
  const card = target.closest('[data-sa]');
  if (card) {
    const key = card.getAttribute('data-sa');
    if (key) deps.toggleCard(key);
    return;
  }
  const all = target.closest('[data-tl-all]');
  if (all) {
    const key = all.getAttribute('data-tl-all');
    if (key) deps.toggleAll(key);
    return;
  }
  const line = target.closest('.tl');
  if (line) {
    deps.toggleLine(line as HTMLElement);
    return;
  }
  if (handleTurnAndHandoffClick(target, deps)) return;
  const btn = target.closest('button[data-btn]');
  if (btn) {
    const runPost = deps.postButton ?? ((el, t) => postButton(el, t));
    runPost(btn as HTMLButtonElement, deps.getTopic());
  }
}

export function attachLogEvents(log: HTMLElement, deps: LogEventsDeps): Disposable {
  const store = new DisposableStore();
  store.add(
    addDisposableListener(log, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (handleNavClick(target, e, deps)) return;
      handleActionClick(target, deps);
    }),
  );
  store.add(
    addDisposableListener(log, 'keydown', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const toolbar = target?.closest<HTMLElement>('.msg-actions');
      if (toolbar) {
        handleToolbarKeydown(e, toolbar);
        return;
      }
      const jumpQuote = target?.closest<HTMLElement>('[data-jump-msg]');
      if (jumpQuote && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        const msgId = jumpQuote.getAttribute('data-jump-msg');
        if (msgId) deps.onJumpToMessage?.(msgId);
      }
    }),
  );
  store.add(
    addDisposableListener(log, 'input', (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement && target.classList.contains('wd-q')) {
        filterWorkdirPicker(target);
      }
    }),
  );
  // Capture phase: <img> error does not bubble.
  store.add(
    addDisposableListener(
      log,
      'error',
      (e) => {
        const target = e.target;
        if (target instanceof HTMLElement && target.classList.contains('shot')) {
          target.style.display = 'none';
        }
      },
      true,
    ),
  );
  return store;
}

import { t as tr } from '../../../i18n/index.js';
import type { TopicEditorElements, TopicEditorIcons } from './types.js';

function svg(name: string, path: string): string {
  return (
    `<svg class="ic ic-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
  );
}

export const DEFAULT_TOPIC_EDITOR_ICONS: TopicEditorIcons = {
  back: svg('chevronLeft', '<path d="M15 5.5 8.5 12l6.5 6.5"/>'),
  more: svg(
    'more',
    '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  ),
  plus: svg('plus', '<path d="M12 5v14M5 12h14"/>'),
  mic: svg(
    'mic',
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  ),
  stop: svg('stop', '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>'),
  send: svg('send', '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>'),
  copy: svg(
    'copy',
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
      '<path d="M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  ),
  check: svg('check', '<path d="m4.5 12.5 5 5L19.5 7"/>'),
  cross: svg('cross', '<path d="M6 6l12 12M18 6 6 18"/>'),
  clock: svg('clock', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>'),
  bolt: svg('bolt', '<path d="M13 2 4.5 13H12l-1 9 8.5-11H12l1-9z"/>'),
  undo: svg('undo', '<path d="M9 6 4 11l5 5"/><path d="M4 11h10.5a5 5 0 0 1 0 10H11"/>'),
  fork: svg(
    'fork',
    '<circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/>' +
      '<path d="M6 7.2V9a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.2M12 12v4.8"/>',
  ),
  power: svg('power', '<path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/>'),
  pause: svg('pause', '<path d="M9 5.5v13M15 5.5v13"/>'),
  trash: svg(
    'trash',
    '<path d="M4 6.5h16M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6 6.5l.9 12.6a1.5 1.5 0 0 0 1.5 1.4h7.2a1.5 1.5 0 0 0 1.5-1.4L18 6.5M10 10.5v6M14 10.5v6"/>',
  ),
  git: svg(
    'git',
    '<circle cx="6.5" cy="6" r="2.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="8" r="2.5"/>' +
      '<path d="M6.5 8.5v7M17.5 10.5c0 3.5-3.5 4.5-8 4.5"/>',
  ),
  folder: svg(
    'folder',
    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  ),
  terminal: svg(
    'terminal',
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
  ),
  offline: svg(
    'offline',
    '<path d="M2.5 8.8a14 14 0 0 1 19 0M5.6 12.3a9.5 9.5 0 0 1 12.8 0M8.8 15.7a5 5 0 0 1 6.4 0"/>' +
      '<circle cx="12" cy="19.2" r="1.3" fill="currentColor" stroke="none"/><path d="M4 3.5 20 20.5"/>',
  ),
  diff: svg(
    'diff',
    '<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>' +
      '<path d="M7 10v4M5 12h4M15 12h4"/>',
  ),
  wrap: svg(
    'wrap',
    '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h5"/><path d="m15 15.5-2.5 2.5 2.5 2.5"/>',
  ),
};

export function resolveTopicEditorIcons(overrides?: Partial<TopicEditorIcons>): TopicEditorIcons {
  return { ...DEFAULT_TOPIC_EDITOR_ICONS, ...overrides };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function assignIdIfAbsent(doc: Document, node: HTMLElement, id: string): void {
  if (!doc.getElementById(id)) node.id = id;
}

function buildHeaderDom(doc: Document, icons: TopicEditorIcons) {
  const header = el(doc, 'header', 'wb-topic-header th');
  const backBtn = el(doc, 'button', 'wb-icon-btn wb-topic-back');
  backBtn.type = 'button';
  backBtn.hidden = true;
  backBtn.title = tr('common.back');
  backBtn.setAttribute('aria-label', tr('common.back'));
  backBtn.innerHTML = icons.back;

  const statusDotHost = el(doc, 'span', 'wb-topic-dot');
  const titleEl = el(doc, 'span', 'wb-topic-title tt');
  assignIdIfAbsent(doc, titleEl, 'topic-title');
  const statePillEl = el(doc, 'span', 'wb-topic-pill pill');
  statePillEl.hidden = true;
  const connPillEl = el(doc, 'span', 'wb-topic-conn');
  connPillEl.hidden = true;

  const spacer = el(doc, 'span', 'wb-spacer sp');
  const toolsHost = el(doc, 'div', 'wb-topic-tools tools');
  toolsHost.hidden = true;

  const moreBtn = el(doc, 'button', 'wb-icon-btn wb-topic-more');
  moreBtn.type = 'button';
  moreBtn.title = tr('topic.topicActions');
  moreBtn.setAttribute('aria-label', tr('topic.topicActions'));
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.innerHTML = icons.more;

  header.append(backBtn, statusDotHost, titleEl, statePillEl, connPillEl, spacer, toolsHost, moreBtn);
  return { header, backBtn, statusDotHost, titleEl, statePillEl, connPillEl, toolsHost, moreBtn };
}

function buildBtwAndModelPopDom(doc: Document, icons: TopicEditorIcons) {
  const btwBox = el(doc, 'div', 'wb-topic-btw');
  assignIdIfAbsent(doc, btwBox, 'btw');
  btwBox.hidden = true;
  btwBox.setAttribute('role', 'dialog');
  const btwHead = el(doc, 'div', 'btw-head');
  const btwTag = el(doc, 'span', 'btw-tag');
  btwTag.textContent = 'btw';
  const btwQ = el(doc, 'div', 'wb-btw-q');
  assignIdIfAbsent(doc, btwQ, 'btw-q');
  const btwClose = el(doc, 'button', 'wb-icon-btn wb-btw-close');
  assignIdIfAbsent(doc, btwClose, 'btw-close');
  btwClose.type = 'button';
  btwClose.title = tr('common.closeEsc');
  btwClose.setAttribute('aria-label', tr('common.close'));
  btwClose.innerHTML = icons.cross;
  btwHead.append(btwTag, btwQ, btwClose);
  const btwBody = el(doc, 'div', 'wb-btw-body');
  assignIdIfAbsent(doc, btwBody, 'btw-body');
  btwBox.append(btwHead, btwBody);

  const modelPop = el(doc, 'div', 'wb-topic-model-pop');
  assignIdIfAbsent(doc, modelPop, 'model-pop');
  modelPop.hidden = true;
  modelPop.setAttribute('role', 'dialog');
  const mpGrab = el(doc, 'div', 'mp-grab');
  mpGrab.setAttribute('aria-hidden', 'true');
  const mpHead = el(doc, 'div', 'mp-head');
  const mpTitle = el(doc, 'div', 'mp-title');
  const mpHeading = el(doc, 'b', 'wb-mp-heading');
  assignIdIfAbsent(doc, mpHeading, 'mp-heading');
  mpHeading.textContent = tr('modelPop.headingModel');
  const mpAgent = el(doc, 'span', 'wb-mp-agent');
  assignIdIfAbsent(doc, mpAgent, 'mp-agent');
  mpTitle.append(mpHeading, mpAgent);
  const mpClose = el(doc, 'button', 'wb-icon-btn wb-mp-close');
  assignIdIfAbsent(doc, mpClose, 'mp-close');
  mpClose.type = 'button';
  mpClose.title = tr('common.closeEsc');
  mpClose.setAttribute('aria-label', tr('common.close'));
  mpClose.innerHTML = icons.cross;
  mpHead.append(mpTitle, mpClose);

  const mpFilter = el(doc, 'input', 'wb-mp-filter');
  assignIdIfAbsent(doc, mpFilter, 'mp-filter');
  mpFilter.type = 'text';
  mpFilter.placeholder = tr('modelPop.filterModels');
  mpFilter.setAttribute('aria-label', tr('modelPop.filterModels'));
  mpFilter.autocomplete = 'off';
  mpFilter.spellcheck = false;

  const mpList = el(doc, 'div', 'wb-mp-list');
  assignIdIfAbsent(doc, mpList, 'mp-list');
  mpList.setAttribute('role', 'listbox');
  const mpFoot = el(doc, 'p', 'mp-foot');
  assignIdIfAbsent(doc, mpFoot, 'mp-foot');
  modelPop.append(mpGrab, mpHead, mpFilter, mpList, mpFoot);

  return { btwBox, btwQ, btwBody, btwClose, modelPop, mpHeading, mpAgent, mpClose, mpFilter, mpList, mpFoot };
}

function buildComposerDom(doc: Document, icons: TopicEditorIcons) {
  const hints = el(doc, 'div', 'wb-topic-hints');
  assignIdIfAbsent(doc, hints, 'hints');
  hints.hidden = true;
  const chips = el(doc, 'div', 'wb-topic-chips');
  assignIdIfAbsent(doc, chips, 'chips');

  const composerForm = el(doc, 'form', 'wb-topic-composer');
  assignIdIfAbsent(doc, composerForm, 'composer');
  const row = el(doc, 'div', 'wb-topic-composer-row comp');
  assignIdIfAbsent(doc, row, 'row');

  const input = el(doc, 'textarea', 'wb-topic-input');
  assignIdIfAbsent(doc, input, 'input');
  input.rows = 1;
  input.placeholder = tr('composer.placeholder');
  input.autocomplete = 'off';

  const picker = el(doc, 'input', 'wb-topic-picker');
  assignIdIfAbsent(doc, picker, 'picker');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;

  const attachBtn = el(doc, 'button', 'wb-icon-btn wb-topic-attach');
  assignIdIfAbsent(doc, attachBtn, 'attach');
  attachBtn.type = 'button';
  attachBtn.title = tr('composer.attachTitle');
  attachBtn.setAttribute('aria-label', tr('composer.attachTitle'));
  attachBtn.innerHTML = icons.plus;

  const micBtn = el(doc, 'button', 'wb-icon-btn wb-topic-mic');
  assignIdIfAbsent(doc, micBtn, 'mic');
  micBtn.type = 'button';
  micBtn.hidden = true;
  micBtn.title = tr('composer.micTitle');
  micBtn.setAttribute('aria-label', tr('composer.micTitle'));
  micBtn.innerHTML = icons.mic;

  const stopBtn = el(doc, 'button', 'wb-topic-stop');
  assignIdIfAbsent(doc, stopBtn, 'stop-turn');
  stopBtn.type = 'button';
  stopBtn.hidden = true;
  stopBtn.title = tr('composer.stopTitle');
  stopBtn.setAttribute('aria-label', tr('composer.stopTitle'));
  const stopLabel = el(doc, 'span', 'wb-send-label');
  stopLabel.textContent = tr('composer.stop');
  const stopIcon = el(doc, 'span', 'wb-send-icon');
  stopIcon.setAttribute('aria-hidden', 'true');
  stopIcon.innerHTML = icons.stop;
  stopBtn.append(stopLabel, stopIcon);

  const sendBtn = el(doc, 'button', 'wb-topic-send send');
  sendBtn.type = 'submit';
  sendBtn.title = tr('composer.sendTitle');
  sendBtn.setAttribute('aria-label', tr('composer.sendTitle'));
  const sendLabel = el(doc, 'span', 'wb-send-label');
  sendLabel.textContent = tr('composer.send');
  const sendIcon = el(doc, 'span', 'wb-send-icon');
  sendIcon.setAttribute('aria-hidden', 'true');
  sendIcon.innerHTML = icons.send ?? DEFAULT_TOPIC_EDITOR_ICONS.send ?? '';
  sendBtn.append(sendLabel, sendIcon);

  row.append(input, picker, attachBtn, micBtn, stopBtn, sendBtn);
  composerForm.append(row);

  return { hints, chips, composerForm, input, picker, attachBtn, micBtn, stopBtn, sendBtn };
}

export function buildTopicEditorDom(doc: Document, icons: TopicEditorIcons): TopicEditorElements {
  const root = el(doc, 'section', 'wb-topic-editor');
  const head = buildHeaderDom(doc, icons);

  const forkNote = el(doc, 'button', 'wb-topic-fork-note');
  assignIdIfAbsent(doc, forkNote, 'fork-note');
  forkNote.type = 'button';
  forkNote.hidden = true;

  const log = el(doc, 'div', 'wb-topic-log log');
  assignIdIfAbsent(doc, log, 'log');
  const typingEl = el(doc, 'div', 'wb-topic-typing');
  assignIdIfAbsent(doc, typingEl, 'typing');
  typingEl.hidden = true;
  typingEl.textContent = '...';
  const noteEl = el(doc, 'div', 'wb-topic-note');
  assignIdIfAbsent(doc, noteEl, 'note');

  const barEl = el(doc, 'div', 'wb-topic-bar bar');
  assignIdIfAbsent(doc, barEl, 'bar');
  const pendingQueueEl = el(doc, 'div', 'wb-topic-pending-queue');
  assignIdIfAbsent(doc, pendingQueueEl, 'pending-queue');
  pendingQueueEl.hidden = true;
  pendingQueueEl.setAttribute('aria-label', tr('pending.aria'));

  const machineNoteEl = el(doc, 'div', 'wb-topic-machine-note');
  assignIdIfAbsent(doc, machineNoteEl, 'machine-note');
  machineNoteEl.setAttribute('role', 'status');
  machineNoteEl.hidden = true;

  const statusRowEl = el(doc, 'div', 'wb-topic-status-row');
  const statusEl = el(doc, 'div', 'wb-topic-status status');
  assignIdIfAbsent(doc, statusEl, 'status');
  statusEl.hidden = true;
  statusEl.title = tr('status.tapDetails');
  const dirEl = el(doc, 'span', 'wb-topic-dir');
  dirEl.hidden = true;
  const powerBtn = el(doc, 'button', 'wb-icon-btn wb-topic-power');
  powerBtn.type = 'button';
  powerBtn.hidden = true;
  powerBtn.title = tr('topic.endAgent');
  powerBtn.setAttribute('aria-label', tr('topic.endAgent'));
  powerBtn.innerHTML = icons.power;
  statusRowEl.append(statusEl, dirEl, powerBtn);

  const popups = buildBtwAndModelPopDom(doc, icons);
  const composer = buildComposerDom(doc, icons);

  barEl.append(
    pendingQueueEl,
    machineNoteEl,
    statusRowEl,
    popups.btwBox,
    popups.modelPop,
    composer.hints,
    composer.chips,
    composer.composerForm,
  );

  root.append(head.header, forkNote, log, typingEl, noteEl, barEl);

  return {
    root,
    ...head,
    forkNote,
    log,
    typingEl,
    noteEl,
    barEl,
    pendingQueueEl,
    machineNoteEl,
    statusRowEl,
    statusEl,
    dirEl,
    powerBtn,
    ...popups,
    ...composer,
  };
}

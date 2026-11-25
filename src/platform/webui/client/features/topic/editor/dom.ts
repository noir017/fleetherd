import { t as tr } from '../../../i18n/index.js';
import { icon } from '../../../../icons.js';
import type { TopicEditorElements, TopicEditorIcons } from './types.js';

export const DEFAULT_TOPIC_EDITOR_ICONS: TopicEditorIcons = {
  back: icon('chevronLeft'),
  more: icon('more'),
  plus: icon('plus'),
  mic: icon('mic'),
  stop: icon('stop'),
  send: icon('send'),
  copy: icon('copy'),
  check: icon('check'),
  cross: icon('cross'),
  clock: icon('clock'),
  bolt: icon('bolt'),
  undo: icon('undo'),
  fork: icon('fork'),
  power: icon('power'),
  pause: icon('pause'),
  trash: icon('trash'),
  git: icon('git'),
  folder: icon('folder'),
  terminal: icon('terminal'),
  offline: icon('offline'),
  diff: icon('diff'),
  wrap: icon('wrap'),
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

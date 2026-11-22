import type {
  InstructionsAgent,
  InstructionsDelivery,
  InstructionsGlobalFile,
  InstructionsPanelList,
  InstructionsRef,
} from '../../../adapter.js';
import type { WebMessage } from '../../protocol.js';
import { icon } from '../../icons.js';
import { t } from '../i18n/index.js';
import { fxBase, type FilesHttpResult, type FilesPanel, type FilesSource } from './files.js';

export interface InstructionsAgentRow {
  target?: string;
  label: string;
}

export interface InstructionsPanelDeps {
  instrOk: boolean;
  settingsPage: HTMLElement;
  settingsBody: HTMLElement;
  filesPanel: FilesPanel;
  getSettingsMsg: () => WebMessage | null;
  getSettingsTopic: () => string;
  getTopic: () => string;
  renderSettings: () => void;
  text: (s: unknown) => string;
  inl: (s: unknown) => string;
  post: (path: string, body: unknown, tries: number) => Promise<Response>;
}

export interface InstructionsPanel {
  load: (force?: boolean) => void;
  ensure: () => void;
  renderOrphans: () => string;
  renderAgent: (row: InstructionsAgentRow, index: number) => string;
  open: (agent: string, file?: string) => void;
  openOrphans: () => void;
}

type InstrListData = (Partial<InstructionsPanelList> & { error?: string }) | null;

interface InstrFileEntry {
  scope: 'global' | 'agent';
  sec: 'shared' | 'own';
  q: string;
  path?: string;
  name: string;
  shown: string;
  sub: string;
  exists: boolean;
  editable: boolean;
  note?: string;
  depth: number;
  via?: string;
  missing?: boolean;
}

interface InstrSection {
  title: string;
  note?: string;
  empty?: string;
}

interface InstrSourceState {
  agent: string;
  orphans?: boolean;
  title: string;
  root: string;
  said: string;
  files: Record<string, InstrFileEntry>;
  order: string[];
  secs: { shared?: InstrSection; own?: InstrSection };
}

interface InstrOwnPayload {
  host?: string;
  error?: string;
  summary?: string;
  root?: string;
  rootState?: 'managed' | 'own' | 'missing';
  refs?: InstructionsRef[];
}

interface InstrState {
  data: InstrListData;
  busy: boolean;
  forMsgId: string | null;
}

function instrFetch(url: string): Promise<FilesHttpResult> {
  return fetch(url, { credentials: 'same-origin' }).then((r) =>
    r
      .json()
      .catch(() => ({}))
      .then((d: Record<string, unknown>) => ({ ok: r.ok, status: r.status, body: d }))
  );
}

function instrAgentIn(d: InstrListData, id: string): InstructionsAgent | null {
  for (const a of (d && d.agents) || []) {
    if (a.id === id) return a;
  }
  return null;
}

function instrOwnIn(d: InstrListData, id: string): InstructionsAgent | null {
  for (const a of (d && d.agents) || []) {
    if (a.id === id && a.own) return a;
  }
  return null;
}

function instrSharedIn(d: InstrListData, id: string): InstructionsGlobalFile[] {
  const out: InstructionsGlobalFile[] = [];
  for (const f of (d && d.global) || []) {
    if ((f.agents || []).indexOf(id) >= 0) out.push(f);
  }
  return out;
}

function instrReach(f: InstructionsGlobalFile): string {
  return f.reach + (f.layer !== 'common' && !(f.agents || []).length ? t('instr.noAgentReads') : '');
}

function instrShared(f: InstructionsGlobalFile): string {
  const n = (f.agents || []).length;
  return n ? t(n === 1 ? 'instr.readsOne' : 'instr.readsMany', { reach: f.reach, count: n }) : instrReach(f);
}

function instrOrphans(d: InstrListData): InstructionsGlobalFile[] {
  const out: InstructionsGlobalFile[] = [];
  for (const f of (d && d.global) || []) {
    if (f.layer !== 'common' && !(f.agents || []).length) out.push(f);
  }
  return out;
}

function instrHost(h?: string): string {
  return h === 'local' ? t('instr.thisMachine') : h || '';
}

function formatDeliveryOutcome(d: InstructionsDelivery, who: string): string {
  if (d.outcome === 'removed' || d.outcome === 'absent') return t('instr.nothingLeft', { who });
  if (d.outcome === 'occupied') {
    return t('instr.occupied', { who, link: d.link || t('instr.itsFile'), detail: d.detail || t('instr.itsOwn') });
  }
  if (d.outcome === 'skipped') return t('instr.skipped', { who });
  if (d.outcome === 'unreachable') return t('instr.unreachable', { host: d.host || '' });
  if (d.outcome === 'not-delivered') return t('instr.notDelivered', { who });
  if (d.outcome === 'next-session') return t('instr.nextSession', { who });
  if (d.outcome === 'off') return t('instr.off', { who });
  return who + ': ' + d.outcome + (d.detail ? ' (' + d.detail + ')' : '') + '.';
}

function instrDelivery(list: readonly InstructionsDelivery[] | undefined, f: InstrFileEntry, src: InstrSourceState): string {
  if (f.scope !== 'global') return t('instr.agentNextSession', { agent: src.agent });
  const items = list || [];
  if (!items.length) return t('instr.noConfiguredAgent');
  const placed: string[] = [];
  const other: string[] = [];
  for (const d of items) {
    const agents = (d.agents || []).join(', ');
    const who = d.host === 'local' ? agents : t('instr.whoOnHost', { agents, host: d.host || '' });
    if (d.outcome === 'linked' || d.outcome === 'relinked' || d.outcome === 'current') placed.push(who);
    else other.push(formatDeliveryOutcome(d, who));
  }
  return (placed.length ? t('instr.placedFor', { who: placed.join('; ') }) : '') + other.join(' ');
}

function indexOwnRefs(src: InstrSourceState, d: InstrListData, own: InstrOwnPayload): void {
  const host = instrHost(own.host || instrOwnIn(d, src.agent)?.host);
  if (own.error) {
    src.secs.own = { title: t('instr.onHost', { host }), note: own.error };
    return;
  }
  const suffix =
    own.rootState === 'managed'
      ? t('instr.rootManaged', { root: own.root || '' })
      : own.rootState === 'missing'
        ? t('instr.rootMissing', { root: own.root || '' })
        : '';
  src.secs.own = { title: t('instr.onHost', { host }), note: String(own.summary || '').replace(/\x60/g, '') + '.' + suffix };
  const refs = own.refs || [];
  for (const r of refs) {
    const id = 'a:' + r.path;
    src.files[id] = {
      scope: 'agent',
      sec: 'own',
      q: 'scope=agent&agent=' + encodeURIComponent(src.agent) + '&path=' + encodeURIComponent(r.path),
      path: r.path,
      name: fxBase(r.shown),
      shown: r.shown,
      exists: r.exists,
      editable: r.editable,
      note: r.note || '',
      depth: r.depth || 1,
      via: r.via || '',
      sub: r.note || (r.kind === 'rule' ? t('instr.rule') : r.kind === 'listed' ? t('instr.listedInConfig') : ''),
    };
    src.order.push(id);
  }
  if (!refs.length) src.secs.own.empty = t('instr.noFileRef');
}

function instrIndex(src: InstrSourceState, d: InstrListData, own: InstrOwnPayload | null): void {
  src.files = {};
  src.order = [];
  src.secs = {};
  src.root = src.agent;
  const g = src.orphans ? instrOrphans(d) : instrSharedIn(d, src.agent);
  if (g.length) {
    src.secs.shared = {
      title: t('instr.sharedTitle'),
      note: src.orphans
        ? t('instr.orphansNote')
        : d && d.on
          ? t('instr.sharedNoteOn')
          : t('instr.sharedNoteOff', { dir: String((d && d.dir) || '') }),
    };
  }
  for (const f of g) {
    const id = 'g:' + f.name;
    src.files[id] = {
      scope: 'global',
      sec: 'shared',
      q: 'scope=global&name=' + encodeURIComponent(f.name),
      name: f.name,
      shown: f.name,
      sub: instrReach(f),
      exists: f.exists,
      editable: true,
      depth: 1,
    };
    src.order.push(id);
  }
  if (own) indexOwnRefs(src, d, own);
}

function renderInstrTree(src: InstrSourceState, activePath: string, text: (s: unknown) => string): string {
  if (!src.order.length && !src.secs.own) {
    return '<div class="skills-empty">' + text(t('instr.noHarnessFile')) + '</div>';
  }
  const head = (key: 'shared' | 'own'): string => {
    const s = src.secs[key];
    return s ? '<div class="fx-sec">' + text(s.title) + '</div>' + (s.note ? '<div class="fx-head">' + text(s.note) + '</div>' : '') : '';
  };
  let h = '';
  let sec: 'shared' | 'own' | null = null;
  for (const id of src.order) {
    const f = src.files[id];
    if (!f) continue;
    const pad = 6 + (f.depth - 1) * 12;
    if (f.sec !== sec) {
      sec = f.sec;
      h += head(sec);
    }
    const tail =
      (f.sub ? '<span class="fx-sub">' + text(f.sub) + '</span>' : '') +
      (f.exists ? '' : '<span class="fx-tag">' + text(t('instr.notWritten')) + '</span>');
    if (!f.editable) {
      h +=
        '<div class="fx-row fx-off" title="' +
        text(f.note) +
        '" style="padding-left:' +
        pad +
        'px"><span class="fx-caret blank"></span>' +
        icon('note') +
        '<span class="fx-name">' +
        text(f.shown) +
        '</span><span class="fx-sub">' +
        text(f.note) +
        '</span></div>';
      continue;
    }
    h +=
      '<button type="button" class="fx-row' +
      (activePath === id ? ' on' : '') +
      '" data-fx-file="' +
      text(id) +
      '" title="' +
      text(f.shown + (f.via ? ' ← ' + f.via : '')) +
      '" style="padding-left:' +
      pad +
      'px"><span class="fx-caret blank"></span>' +
      icon('note') +
      '<span class="fx-name">' +
      text(f.shown) +
      '</span>' +
      tail +
      '</button>';
  }
  if (src.secs.own && sec !== 'own') {
    h += head('own') + (src.secs.own.empty ? '<div class="skills-empty">' + text(src.secs.own.empty) + '</div>' : '');
  }
  return h;
}

// Security invariant 10: files are addressed by daemon-indexed ids (g:<name>, a:<path>), never free paths.
function makeInstrSource(
  src: InstrSourceState,
  deps: InstructionsPanelDeps,
  onClose: () => void
): FilesSource {
  const source: FilesSource = {
    title: src.title,
    get: (route, params) => {
      if (route === 'list') {
        const listed = (): FilesHttpResult => ({ ok: true, status: 200, body: { path: src.root, entries: [] } });
        return instrFetch('api/instructions').then((res) => {
          if (!res.ok) return res;
          const d = res.body as InstrListData;
          if (src.orphans || !instrOwnIn(d, src.agent)) {
            instrIndex(src, d, null);
            return listed();
          }
          return instrFetch('api/instructions/refs?agent=' + encodeURIComponent(src.agent)).then(
            (rr) => {
              const own: InstrOwnPayload = rr.ok
                ? (rr.body as InstrOwnPayload)
                : { error: (typeof rr.body.error === 'string' && rr.body.error) || t('instr.ownListErr') };
              instrIndex(src, d, own);
              return listed();
            },
            () => {
              instrIndex(src, d, { error: t('instr.ownListReachErr') });
              return listed();
            }
          );
        });
      }
      const id = params.path || '';
      const f = route === 'read' ? src.files[id] : undefined;
      if (!f) {
        return Promise.resolve({
          ok: false,
          status: 400,
          body: { error: route === 'read' ? t('instr.fileNotInList') : t('instr.notAvailable') },
        });
      }
      return instrFetch('api/instructions/read?' + f.q + (params.preview ? '&preview=1' : '')).then((res) => {
        if (!res.ok) return res;
        f.missing = Boolean(res.body.missing);
        res.body.path = id;
        res.body.rel = f.shown;
        res.body.dir = '';
        if (f.missing && !res.body.note) res.body.note = t('instr.notWrittenNote');
        else if (f.note && !res.body.note) res.body.note = f.note.charAt(0).toUpperCase() + f.note.slice(1) + '.';
        return res;
      });
    },
    post: (route, body) => {
      const id = typeof body.path === 'string' ? body.path : '';
      const f = route === 'write' ? src.files[id] : undefined;
      if (!f) return Promise.resolve({ ok: false, status: 400, body: { error: t('instr.notAvailable') } });
      const req: Record<string, unknown> =
        f.scope === 'global'
          ? { scope: 'global', name: f.name }
          : { scope: 'agent', agent: src.agent, path: f.path };
      req.text = body.text;
      if (body.force) {
        req.force = true;
      } else if (f.missing) {
        req.missing = true;
      } else {
        if (body.mtimeMs !== undefined) req.mtimeMs = body.mtimeMs;
        if (body.size !== undefined) req.size = body.size;
        if (body.sha256) req.sha256 = body.sha256;
      }
      src.said = '';
      return deps.post('api/instructions/write', req, 1).then((r) =>
        r
          .json()
          .catch(() => ({}))
          .then((d: Record<string, unknown>) => {
            if (r.ok) {
              f.missing = false;
              f.exists = true;
              src.said = instrDelivery(d.delivery as InstructionsDelivery[] | undefined, f, src);
              if (deps.filesPanel.currentSource() === source) deps.filesPanel.paintTree();
            }
            return { ok: r.ok, status: r.status, body: d };
          })
      );
    },
    renderTree: (activePath) => renderInstrTree(src, activePath, deps.text),
    said: () => (src.said ? ' ' + src.said : ''),
    onClose,
  };
  return source;
}

function instrArrived(deps: InstructionsPanelDeps): void {
  const msg = deps.getSettingsMsg();
  if (!deps.instrOk || !msg || deps.settingsPage.hidden) return;
  if (!msg.settings || msg.settings.level !== 'list') return;
  // Skip redraw while a control is .busy so its optimistic disabled state is not reverted mid-request.
  if (deps.settingsBody.querySelector('.busy')) return;
  deps.renderSettings();
}

function loadInstructions(state: InstrState, deps: InstructionsPanelDeps, force?: boolean): void {
  if (!deps.instrOk || state.busy || (state.data && !force)) return;
  state.busy = true;
  instrFetch('api/instructions').then(
    (res) => {
      state.busy = false;
      state.data = res.ok
        ? (res.body as InstrListData)
        : { error: (typeof res.body.error === 'string' && res.body.error) || t('instr.listErr') };
      instrArrived(deps);
    },
    () => {
      state.busy = false;
      state.data = { error: t('common.reachDaemonError') };
      instrArrived(deps);
    }
  );
}

function renderOrphansHtml(state: InstrState, deps: InstructionsPanelDeps): string {
  if (!deps.instrOk || !state.data || state.data.error) return '';
  const o = instrOrphans(state.data);
  if (!o.length) return '';
  const names = o.map((f) => f.name).join(', ');
  return (
    '<div class="set-card"><button type="button" class="set-item set-open" data-instr-orphans="1">' +
    '<span class="set-tx"><span class="set-label">' +
    deps.text(t('instr.orphansTitle')) +
    '</span>' +
    '<span class="set-hint">' +
    deps.text(t('instr.orphansHint', { names })) +
    '</span></span>' +
    '<span class="set-chev" aria-hidden="true">' +
    icon('chevronRight') +
    '</span></button></div>'
  );
}

function renderAgentHtml(state: InstrState, deps: InstructionsPanelDeps, r: InstructionsAgentRow, i: number): string {
  if (!deps.instrOk) return '';
  const id = String(r.target || r.label);
  const d = state.data;
  let h = '<div class="ag-field ag-instr"><span class="ag-lab">' + deps.text(t('instr.title')) + '</span><div class="ag-val">';
  if (!d) return h + '<span class="ag-wait">' + deps.text(t('common.loading')) + '</span></div></div>';
  if (d.error) return h + '<span class="ag-err">' + deps.text(d.error) + '</span></div></div>';
  const row = instrAgentIn(d, id);
  const g = instrSharedIn(d, id);
  const own = instrOwnIn(d, id);
  const off = Boolean(row && row.notDelivered);
  if (!g.length && !own && !off) {
    return h + '<span class="ag-none">' + deps.text(t('instr.noHarnessFile')) + '</span></div></div>';
  }
  if (off) {
    h += '<span class="ag-none">' + deps.text(t('instr.notDelivering')) + '</span>';
  }
  let files = '';
  let n = 0;
  for (const f of g) {
    files +=
      '<button type="button" class="ag-file" data-fk="r' +
      i +
      'i' +
      n++ +
      '" data-instr-agent="' +
      deps.text(id) +
      '" data-instr-file="' +
      deps.text('g:' + f.name) +
      '" aria-label="' +
      deps.text(r.label + ' · ' + f.name) +
      '" title="' +
      deps.text((f.agents || []).join(', ')) +
      '">' +
      '<span class="ag-fname">' +
      deps.text(f.name) +
      '</span>' +
      '<span class="ag-fsub">' +
      deps.text(instrShared(f)) +
      (f.exists ? '' : '<span class="fx-tag">' + deps.text(t('instr.notWritten')) + '</span>') +
      '</span>' +
      '<span class="set-chev" aria-hidden="true">' +
      icon('chevronRight') +
      '</span></button>';
  }
  if (own) {
    files +=
      '<button type="button" class="ag-file" data-fk="r' +
      i +
      'i' +
      n++ +
      '" data-instr-agent="' +
      deps.text(id) +
      '" aria-label="' +
      deps.text(t('instr.itsOwnFilesAria', { label: r.label })) +
      '">' +
      '<span class="ag-fname own">' +
      deps.text(t('instr.itsOwnFiles')) +
      '</span>' +
      '<span class="ag-fsub">' +
      deps.inl(own.own) +
      ' · ' +
      deps.text(instrHost(own.host)) +
      '</span>' +
      '<span class="set-chev" aria-hidden="true">' +
      icon('chevronRight') +
      '</span></button>';
  }
  return h + (files ? '<div class="ag-files">' + files + '</div>' : '') + '</div></div>';
}

function openInstrWindow(
  state: InstrState,
  deps: InstructionsPanelDeps,
  opts: { agent: string; file?: string; orphans?: boolean; title: string }
): void {
  const srcState: InstrSourceState = {
    agent: opts.agent,
    orphans: opts.orphans,
    title: opts.title,
    root: '',
    said: '',
    files: {},
    order: [],
    secs: {},
  };
  deps.filesPanel.open(
    deps.getSettingsTopic() || deps.getTopic(),
    opts.file || '',
    makeInstrSource(srcState, deps, () => loadInstructions(state, deps, true))
  );
}

export function createInstructionsPanel(deps: InstructionsPanelDeps): InstructionsPanel {
  const state: InstrState = { data: null, busy: false, forMsgId: null };
  const open = (agent: string, file?: string): void =>
    openInstrWindow(state, deps, { agent, file, title: t('instr.agentTitle', { agent }) });
  const openOrphans = (): void =>
    openInstrWindow(state, deps, { agent: '', orphans: true, title: t('instr.orphansTitle') });

  // Security invariant 10: bind no entry handlers when instructions.enabled is off.
  if (deps.instrOk) {
    deps.settingsBody.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest('[data-instr-orphans]')) {
        openOrphans();
        return;
      }
      const a = target.closest('[data-instr-agent]');
      const agent = a ? a.getAttribute('data-instr-agent') : null;
      if (a && agent !== null) open(agent, a.getAttribute('data-instr-file') || '');
    });
  }

  return {
    load: (force) => loadInstructions(state, deps, force),
    ensure: () => {
      const msg = deps.getSettingsMsg();
      if (!msg || state.forMsgId === msg.id) return;
      state.forMsgId = msg.id;
      loadInstructions(state, deps, true);
    },
    renderOrphans: () => renderOrphansHtml(state, deps),
    renderAgent: (row, index) => renderAgentHtml(state, deps, row, index),
    open,
    openOrphans,
  };
}

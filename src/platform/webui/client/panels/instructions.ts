import type {
  InstructionsAgent,
  InstructionsDelivery,
  InstructionsGlobalFile,
  InstructionsPanelList,
  InstructionsRef,
} from '../../../adapter.js';
import type { WebMessage } from '../../protocol.js';
import { icon } from '../../icons.js';
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
  return f.reach + (f.layer !== 'common' && !(f.agents || []).length ? ' · no agent reads it' : '');
}

function instrShared(f: InstructionsGlobalFile): string {
  const n = (f.agents || []).length;
  return n ? f.reach + ' · ' + n + (n === 1 ? ' reads it' : ' read it') : instrReach(f);
}

function instrOrphans(d: InstrListData): InstructionsGlobalFile[] {
  const out: InstructionsGlobalFile[] = [];
  for (const f of (d && d.global) || []) {
    if (f.layer !== 'common' && !(f.agents || []).length) out.push(f);
  }
  return out;
}

function instrHost(h?: string): string {
  return h === 'local' ? 'this machine' : h || '';
}

function formatDeliveryOutcome(d: InstructionsDelivery, who: string): string {
  if (d.outcome === 'removed' || d.outcome === 'absent') return 'Nothing is left for ' + who + '.';
  if (d.outcome === 'occupied') {
    return (
      who +
      ': ' +
      (d.link || 'its file') +
      ' is ' +
      (d.detail || 'its own') +
      ', left alone, so these do not reach it.'
    );
  }
  if (d.outcome === 'skipped') return who + ': its harness has not run there yet, so nothing was placed.';
  if (d.outcome === 'unreachable') return d.host + ' did not answer; it gets this when an agent next starts there.';
  if (d.outcome === 'not-delivered') {
    return who + ': its delivery is off — its file is already delivered to another agent there, so nothing was placed.';
  }
  if (d.outcome === 'next-session') return who + ': given this when its next session starts; one already running keeps what it read.';
  if (d.outcome === 'off') return who + ': this gateway places no instructions, so nothing was placed now.';
  return who + ': ' + d.outcome + (d.detail ? ' (' + d.detail + ')' : '') + '.';
}

function instrDelivery(list: readonly InstructionsDelivery[] | undefined, f: InstrFileEntry, src: InstrSourceState): string {
  if (f.scope !== 'global') return src.agent + ' reads it when its next session starts.';
  const items = list || [];
  if (!items.length) return 'No configured agent reads this file.';
  const placed: string[] = [];
  const other: string[] = [];
  for (const d of items) {
    const who = (d.agents || []).join(', ') + (d.host === 'local' ? '' : ' on ' + d.host);
    if (d.outcome === 'linked' || d.outcome === 'relinked' || d.outcome === 'current') placed.push(who);
    else other.push(formatDeliveryOutcome(d, who));
  }
  return (
    (placed.length ? 'Placed for ' + placed.join('; ') + '; a session already running keeps what it read. ' : '') +
    other.join(' ')
  );
}

function indexOwnRefs(src: InstrSourceState, d: InstrListData, own: InstrOwnPayload): void {
  const host = instrHost(own.host || instrOwnIn(d, src.agent)?.host);
  if (own.error) {
    src.secs.own = { title: 'On ' + host, note: own.error };
    return;
  }
  const suffix =
    own.rootState === 'managed'
      ? ' ' + (own.root || '') + ' is the gateway’s copy: add a reference to a shared file above.'
      : own.rootState === 'missing'
        ? ' ' + (own.root || '') + ' does not exist there.'
        : '';
  src.secs.own = { title: 'On ' + host, note: String(own.summary || '').replace(/\x60/g, '') + '.' + suffix };
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
      sub: r.note || (r.kind === 'rule' ? 'rule' : r.kind === 'listed' ? 'listed in its config' : ''),
    };
    src.order.push(id);
  }
  if (!refs.length) src.secs.own.empty = 'No file is referenced.';
}

function instrIndex(src: InstrSourceState, d: InstrListData, own: InstrOwnPayload | null): void {
  src.files = {};
  src.order = [];
  src.secs = {};
  src.root = src.agent;
  const g = src.orphans ? instrOrphans(d) : instrSharedIn(d, src.agent);
  if (g.length) {
    src.secs.shared = {
      title: 'Shared, kept on the gateway',
      note: src.orphans
        ? 'No configured agent reads these. Clearing one keeps a later agent on that layer from inheriting it.'
        : d && d.on
          ? 'A save places it on every machine an agent that reads it is configured for.'
          : 'Nothing is delivered yet. The first save creates ' + String((d && d.dir) || '') + '.',
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
    return '<div class="skills-empty">Its harness reads no instruction file the gateway knows of.</div>';
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
      (f.exists ? '' : '<span class="fx-tag">not written</span>');
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
                : { error: (typeof rr.body.error === 'string' && rr.body.error) || 'Its own files could not be listed.' };
              instrIndex(src, d, own);
              return listed();
            },
            () => {
              instrIndex(src, d, { error: 'Its own files could not be listed: the daemon did not answer.' });
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
          body: { error: route === 'read' ? 'That file is not in the list any more. Refresh it.' : 'Not available for instructions.' },
        });
      }
      return instrFetch('api/instructions/read?' + f.q + (params.preview ? '&preview=1' : '')).then((res) => {
        if (!res.ok) return res;
        f.missing = Boolean(res.body.missing);
        res.body.path = id;
        res.body.rel = f.shown;
        res.body.dir = '';
        if (f.missing && !res.body.note) res.body.note = 'Not written yet. Saving creates it.';
        else if (f.note && !res.body.note) res.body.note = f.note.charAt(0).toUpperCase() + f.note.slice(1) + '.';
        return res;
      });
    },
    post: (route, body) => {
      const id = typeof body.path === 'string' ? body.path : '';
      const f = route === 'write' ? src.files[id] : undefined;
      if (!f) return Promise.resolve({ ok: false, status: 400, body: { error: 'Not available for instructions.' } });
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
        : { error: (typeof res.body.error === 'string' && res.body.error) || 'The instructions could not be listed.' };
      instrArrived(deps);
    },
    () => {
      state.busy = false;
      state.data = { error: 'Could not reach the daemon.' };
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
    '<span class="set-tx"><span class="set-label">Instructions no agent reads</span>' +
    '<span class="set-hint">' +
    deps.text(names) +
    ' — open to clear a layer a later agent would inherit</span></span>' +
    '<span class="set-chev" aria-hidden="true">' +
    icon('chevronRight') +
    '</span></button></div>'
  );
}

function renderAgentHtml(state: InstrState, deps: InstructionsPanelDeps, r: InstructionsAgentRow, i: number): string {
  if (!deps.instrOk) return '';
  const id = String(r.target || r.label);
  const d = state.data;
  let h = '<div class="ag-field ag-instr"><span class="ag-lab">Instructions</span><div class="ag-val">';
  if (!d) return h + '<span class="ag-wait">Loading…</span></div></div>';
  if (d.error) return h + '<span class="ag-err">' + deps.text(d.error) + '</span></div></div>';
  const row = instrAgentIn(d, id);
  const g = instrSharedIn(d, id);
  const own = instrOwnIn(d, id);
  const off = Boolean(row && row.notDelivered);
  if (!g.length && !own && !off) {
    return h + '<span class="ag-none">Its harness reads no instruction file the gateway knows of.</span></div></div>';
  }
  if (off) {
    h +=
      '<span class="ag-none">Not delivering: its instruction file is already delivered to another agent on the same machine with a different layer.</span>';
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
      (f.exists ? '' : '<span class="fx-tag">not written</span>') +
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
      deps.text(r.label + ' · its own files') +
      '">' +
      '<span class="ag-fname own">Its own files</span>' +
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
    openInstrWindow(state, deps, { agent, file, title: agent + ' · instructions' });
  const openOrphans = (): void =>
    openInstrWindow(state, deps, { agent: '', orphans: true, title: 'Instructions no agent reads' });

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

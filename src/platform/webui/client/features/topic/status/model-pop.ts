import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { post, text } from '../../../services/api.js';
import type {
  ModelChoiceResponse,
  ModelListResponse,
  OptionChoiceResponse,
  OptionListResponse,
  SessionOption,
  StatusIcons,
  StatusPermissions,
} from './types.js';

export const MODEL_WAIT_MS = 45000;
export const PERM_OPT_ID = '__permissions__';
/** The daemon's EFFORT_OPTION_ID (platform/workbench.ts): `api/options` takes the effort switch under it. */
export const EFFORT_OPT_ID = '__effort__';

export interface ModelPopElements {
  readonly modelPop: HTMLElement | null;
  readonly mpList: HTMLElement | null;
  readonly mpFilter: HTMLInputElement | null;
  readonly mpAgent: HTMLElement | null;
  readonly mpHeading: HTMLElement | null;
  readonly mpFoot: HTMLElement | null;
  readonly mpClose: HTMLElement | null;
}

export interface ModelPopDeps {
  readonly els: ModelPopElements;
  readonly doc?: Document;
  readonly getTopic: () => string;
  readonly getIcons: () => Pick<StatusIcons, 'check'>;
  readonly narrow: () => boolean;
  readonly inl: (s: string) => string;
  readonly resolveOptName: (id: string) => string;
  readonly onVisibilityChange: () => void;
  readonly onListLoaded: (topic: string) => void;
  readonly onModelChosen: (topic: string, model: string | undefined) => void;
  readonly onOptionChosen: (topic: string) => void;
  readonly onPermChosen?: (topic: string, level: string) => void;
  /** The effort level the list or a change reported; null when the current model offers none. */
  readonly onEffortKnown?: (topic: string, level: string | null) => void;
  readonly setNote: (msg: string) => void;
  readonly fetchFn?: typeof fetch;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
}

export interface ModelPopController {
  isOpen(): boolean;
  currentOpt(): string | null;
  openModel(): void;
  openOption(id: string): void;
  openPermissions(agent: string, perms: StatusPermissions): void;
  openEffort(): void;
  close(): void;
  render(): void;
  filter(): void;
  refreshI18n(): void;
  attach(): Disposable;
}

interface PopState {
  topic: string | null;
  opt: string | null;
  data: ModelListResponse | OptionListResponse | null;
  err: string;
  loading: boolean;
  busy: boolean;
  seq: number;
}

export function matchesFilter(query: string, searchableText: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return searchableText.toLowerCase().indexOf(q) >= 0;
}

export function findSessionOption(
  data: OptionListResponse | null,
  optId: string | null,
): SessionOption | null {
  if (!data || !optId || !Array.isArray(data.options)) return null;
  for (const item of data.options) {
    if (item.id === optId) return item;
  }
  return null;
}

export function shouldShowFilter(
  data: ModelListResponse | OptionListResponse | null,
  optId: string | null,
): boolean {
  if (!data || !data.ok) return false;
  if (optId) {
    const opt = findSessionOption(data as OptionListResponse, optId);
    return (opt ? opt.options.length : 0) > 8;
  }
  const models = (data as ModelListResponse).options;
  return Array.isArray(models) && models.length > 8;
}

/**
 * The options list as the effort switch draws it: the levels as one setting, so the popover renders
 * them like any other. A list without levels is the model having none, unless the agent did not start.
 */
export function effortListData(j: OptionListResponse): OptionListResponse {
  if (j.effort) {
    return {
      ok: true,
      ...(j.agent ? { agent: j.agent } : {}),
      options: [
        {
          id: EFFORT_OPT_ID,
          name: tr('status.effortLabel'),
          ...(j.effort.current !== undefined ? { current: j.effort.current } : {}),
          options: j.effort.options.map((o) => ({ value: o.value, name: o.name })),
        },
      ],
    };
  }
  if (!j.ok && j.reason === 'error') return j;
  return { ok: false, ...(j.agent ? { agent: j.agent } : {}), text: tr('modelPop.effortNone') };
}

export function renderModelOptionsHtml(data: ModelListResponse, checkIcon: string): string {
  const options = data.options ?? [];
  let h = '';
  for (const o of options) {
    const on = o.value === data.current;
    const def = Boolean(data.configured && o.value === data.configured);
    const name = o.name && o.name !== o.value ? o.name : '';
    h +=
      `<button type="button" class="mp-opt${on ? ' on' : ''}" role="option" aria-selected="${on ? 'true' : 'false'}" data-v="${text(o.value)}"` +
      ` data-q="${text(`${o.value} ${name}`.toLowerCase())}">` +
      `<span class="mp-check" aria-hidden="true">${on ? checkIcon : ''}</span>` +
      `<span class="mp-main"><span class="mp-v">${text(o.value)}</span>${name ? `<span class="mp-n">${text(name)}</span>` : ''}</span>` +
      `${def ? `<span class="mp-tag" title="${text(tr('modelPop.defaultTitle'))}">${text(tr('chat.defaultTag'))}</span>` : ''}` +
      `</button>`;
  }
  return h;
}

export function renderSessionOptionsHtml(
  option: SessionOption | null,
  checkIcon: string,
): string {
  if (!option) return `<div class="mp-msg">${text(tr('modelPop.optGone'))}</div>`;
  const fixed = option.options.length <= 1;
  let h = fixed
    ? `<div class="mp-msg">${text(tr('modelPop.optFixed', { name: option.name }))}</div>`
    : '';
  for (const choice of option.options) {
    const on = choice.value === option.current;
    const searchKey = `${choice.name} ${choice.value} ${choice.description || ''}`.toLowerCase();
    h +=
      `<button type="button" class="mp-opt${on ? ' on' : ''}" role="option" aria-selected="${on ? 'true' : 'false'}" data-v="${text(choice.value)}"` +
      ` data-q="${text(searchKey)}"${fixed ? ' disabled' : ''}>` +
      `<span class="mp-check" aria-hidden="true">${on ? checkIcon : ''}</span>` +
      `<span class="mp-main"><span class="mp-o">${text(choice.name)}</span>${choice.description ? `<span class="mp-n">${text(choice.description)}</span>` : ''}</span>` +
      `</button>`;
  }
  return h;
}

class ModelPopControllerImpl implements ModelPopController {
  private readonly doc: Document;
  private readonly fetchFn: typeof fetch;
  private readonly postFn: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  private readonly mp: PopState = {
    topic: null,
    opt: null,
    data: null,
    err: '',
    loading: false,
    busy: false,
    seq: 0,
  };

  constructor(private readonly deps: ModelPopDeps) {
    this.doc = deps.doc ?? document;
    this.fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.postFn = deps.postFn ?? post;
  }

  isOpen(): boolean {
    const { modelPop } = this.deps.els;
    return Boolean(modelPop && !modelPop.hidden);
  }

  currentOpt(): string | null {
    return this.isOpen() ? this.mp.opt : null;
  }

  openModel(): void {
    this.openPop(null);
  }

  openOption(id: string): void {
    this.openPop(id);
  }

  openEffort(): void {
    this.openPop(EFFORT_OPT_ID);
  }

  openPermissions(agent: string, perms: StatusPermissions): void {
    const { modelPop, mpFilter } = this.deps.els;
    const t = this.deps.getTopic();
    if (!t || !modelPop || !agent) return;
    this.mp.seq++;
    this.mp.topic = t;
    this.mp.opt = PERM_OPT_ID;
    this.mp.err = '';
    this.mp.loading = false;
    this.mp.busy = false;
    this.mp.data = {
      ok: true,
      agent,
      options: [
        {
          id: PERM_OPT_ID,
          name: tr('status.permLabel'),
          current: perms.level,
          options: perms.offered.map((v) => ({ value: v, name: v })),
        },
      ],
    };
    if (mpFilter) mpFilter.value = '';
    this.applyChromeText(PERM_OPT_ID);
    modelPop.hidden = false;
    this.deps.onVisibilityChange();
    this.render();
  }

  private applyChromeText(opt: string | null): void {
    const { mpHeading, mpFilter, mpFoot } = this.deps.els;
    if (mpHeading) {
      mpHeading.textContent = opt
        ? tr('modelPop.headingOpt', { name: this.deps.resolveOptName(opt) })
        : tr('modelPop.headingModel');
    }
    if (mpFilter) {
      mpFilter.placeholder = opt ? tr('common.filter') : tr('modelPop.filterModels');
    }
    if (mpFoot) {
      mpFoot.innerHTML =
        opt === EFFORT_OPT_ID ? tr('modelPop.footEffort') : opt ? tr('modelPop.footOpt') : tr('modelPop.footModel');
    }
  }

  filter(): void {
    const { mpList, mpFilter } = this.deps.els;
    if (!mpList || !mpFilter) return;
    const q = mpFilter.value;
    const opts = mpList.querySelectorAll<HTMLElement>('.mp-opt');
    for (let i = 0; i < opts.length; i++) {
      const node = opts[i];
      if (!node) continue;
      node.hidden = !matchesFilter(q, node.getAttribute('data-q') || '');
    }
  }

  render(): void {
    const { mpList, mpAgent, mpFilter } = this.deps.els;
    if (!mpList) return;
    const d = this.mp.data;
    if (mpAgent) mpAgent.textContent = d && d.agent ? d.agent : '';
    if (mpFilter) mpFilter.hidden = !shouldShowFilter(d, this.mp.opt);
    if (this.mp.loading) {
      const label = this.mp.opt ? tr('modelPop.askingSettings') : tr('modelPop.askingModels');
      mpList.innerHTML = `<div class="mp-msg mp-wait"><span class="set-spin" aria-hidden="true"></span>${text(label)}</div>`;
      return;
    }
    if (this.mp.err) {
      mpList.innerHTML = `<div class="mp-msg err">${this.deps.inl(this.mp.err)}</div>`;
      return;
    }
    if (!d || !d.ok) {
      mpList.innerHTML = `<div class="mp-msg">${this.deps.inl(d && d.text ? d.text : '')}</div>`;
      return;
    }
    const checkIcon = this.deps.getIcons().check;
    if (this.mp.opt) {
      mpList.innerHTML = renderSessionOptionsHtml(
        findSessionOption(d as OptionListResponse, this.mp.opt),
        checkIcon,
      );
      this.filter();
      return;
    }
    mpList.innerHTML = renderModelOptionsHtml(d as ModelListResponse, checkIcon);
    this.filter();
  }

  close(): void {
    const { modelPop, mpList } = this.deps.els;
    if (!modelPop || modelPop.hidden) return;
    this.mp.seq++;
    modelPop.hidden = true;
    if (mpList) mpList.innerHTML = '';
    this.deps.onVisibilityChange();
  }

  private openPop(opt: string | null): void {
    const { modelPop, mpFilter } = this.deps.els;
    const t = this.deps.getTopic();
    if (!t || !modelPop) return;
    const n = ++this.mp.seq;
    this.mp.topic = t;
    this.mp.opt = opt;
    this.mp.data = null;
    this.mp.err = '';
    this.mp.loading = true;
    this.mp.busy = false;
    if (mpFilter) mpFilter.value = '';
    this.applyChromeText(opt);
    modelPop.hidden = false;
    this.deps.onVisibilityChange();
    this.render();
    // Skip focus on narrow screens so the virtual keyboard does not cover the list.
    if (!this.deps.narrow() && mpFilter) mpFilter.focus();
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (ctl) ctl.abort();
    }, MODEL_WAIT_MS);
    const url = `${opt ? 'api/options?t=' : 'api/models?t='}${encodeURIComponent(t)}`;
    const init: RequestInit = ctl
      ? { credentials: 'same-origin', signal: ctl.signal }
      : { credentials: 'same-origin' };
    this.fetchFn(url, init)
      .then((r) =>
        (r.json() as Promise<ModelListResponse | OptionListResponse>).then((j) => ({ r, j })),
      )
      .then(
        ({ r, j }) => {
          clearTimeout(timer);
          if (n !== this.mp.seq) return;
          this.mp.loading = false;
          if (!r.ok) this.mp.err = tr('modelPop.httpErr', { status: r.status });
          else this.mp.data = opt === EFFORT_OPT_ID ? this.effortLoaded(t, j as OptionListResponse) : j;
          this.render();
          if (r.ok && j && j.ok) this.deps.onListLoaded(t);
        },
        () => {
          clearTimeout(timer);
          if (n !== this.mp.seq) return;
          this.mp.loading = false;
          this.mp.err = tr('modelPop.reachErr');
          this.render();
        },
      );
  }

  private effortLoaded(t: string, j: OptionListResponse): OptionListResponse {
    const data = effortListData(j);
    if (j.effort) {
      if (j.effort.current) this.deps.onEffortKnown?.(t, j.effort.current);
    } else if (data !== j) this.deps.onEffortKnown?.(t, null);
    return data;
  }

  private chooseModel(button: HTMLButtonElement): void {
    if (this.mp.busy || !this.mp.topic || button.disabled) return;
    const n = this.mp.seq;
    const t = this.mp.topic;
    const v = button.getAttribute('data-v');
    const opt = this.mp.opt;
    this.mp.busy = true;
    button.classList.add('busy');
    if (opt === PERM_OPT_ID) {
      const agent = this.mp.data?.agent;
      if (!agent || !v) {
        this.mp.busy = false;
        return;
      }
      this.postFn('api/send', { topic: t, text: `/setting permissions.${agent} ${v}` }, 1, MODEL_WAIT_MS).then(
        (r) => {
          this.mp.busy = false;
          if (n !== this.mp.seq) return;
          if (r.ok) {
            this.close();
            this.deps.onPermChosen?.(t, v);
            return;
          }
          this.mp.err = tr('modelPop.refused', { status: r.status });
          this.render();
        },
        () => {
          this.mp.busy = false;
          if (n !== this.mp.seq) return;
          this.mp.err = tr('modelPop.reachChangeOpt');
          this.render();
        },
      );
      return;
    }
    const path = opt ? 'api/options' : 'api/models';
    const body = opt ? { topic: t, id: opt, value: v } : { topic: t, value: v };
    this.postFn(path, body, 1, MODEL_WAIT_MS)
      .then((r) =>
        (r.json() as Promise<ModelChoiceResponse | OptionChoiceResponse>).then((j) => ({ r, j })),
      )
      .then(
        ({ r, j }) => {
          this.mp.busy = false;
          if (n !== this.mp.seq) return;
          if (r.ok && j.ok) {
            if (!opt) this.deps.onModelChosen(t, (j as ModelChoiceResponse).model);
            this.close();
            this.deps.setNote(String(j.text || '').replace(/`/g, ''));
            if (opt === EFFORT_OPT_ID) this.deps.onEffortKnown?.(t, (j as OptionChoiceResponse).effort || v);
            else if (opt) this.deps.onOptionChosen(t);
            return;
          }
          this.mp.err = j && j.text ? j.text : tr('modelPop.refused', { status: r.status });
          this.render();
        },
        () => {
          this.mp.busy = false;
          if (n !== this.mp.seq) return;
          this.mp.err = opt ? tr('modelPop.reachChangeOpt') : tr('modelPop.reachChangeModel');
          this.render();
        },
      );
  }

  refreshI18n(): void {
    if (!this.isOpen()) return;
    this.applyChromeText(this.mp.opt);
    this.render();
  }

  attach(): Disposable {
    const { mpList, mpFilter, mpClose } = this.deps.els;
    const store = new DisposableStore();
    if (mpList) {
      store.add(
        addDisposableListener(mpList, 'click', (e) => {
          const target = e.target;
          const btn = target instanceof Element ? target.closest<HTMLButtonElement>('.mp-opt') : null;
          if (btn) this.chooseModel(btn);
        }),
      );
    }
    if (mpFilter) {
      store.add(addDisposableListener(mpFilter, 'input', () => this.filter()));
    }
    if (mpClose) {
      store.add(addDisposableListener(mpClose, 'click', () => this.close()));
    }
    // Capture-phase Escape keeps the composer menu independent from the page-wide overlay stack.
    store.add(
      addDisposableListener(
        this.doc,
        'keydown',
        (e) => {
          if (e.key === 'Escape' && this.isOpen()) {
            this.close();
            e.stopPropagation();
          }
        },
        true,
      ),
    );
    store.add(
      addDisposableListener(this.doc, 'click', (e) => {
        if (!this.isOpen()) return;
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest('#model-pop, .wb-topic-model-pop') || target.closest('.st-model')) return;
        this.close();
      }),
    );
    return store;
  }
}

export function createModelPopController(deps: ModelPopDeps): ModelPopController {
  return new ModelPopControllerImpl(deps);
}

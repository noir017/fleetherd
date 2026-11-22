import type {
  ReviewPanelChange,
  ReviewPanelEntry,
  ReviewPanelList,
  ReviewPanelPreference,
} from '../../../adapter.js';
import type { ReviewOpRequest, SkillOpRequest } from '../../protocol.js';
import { t } from '../i18n/index.js';

export interface ReviewsPanelDeps {
  app: HTMLElement;
  revList: HTMLElement;
  text: (s: unknown) => string;
  schedAgo: (at: number) => string;
  post: (path: string, body: unknown, tries: number) => Promise<Response>;
  showNote: (msg: string) => void;
  paintCounts: () => void;
  paintSummary: () => void;
  topicExists: (id: string) => boolean;
  switchTopic: (id: string) => void;
  createTopic: (seed: { text: string; draft: string }) => Promise<boolean>;
  beforeSkillArchive: () => void;
  afterSkillArchive: (refreshPending: boolean) => void;
}

export interface ReviewsPanel {
  load: () => void;
  paint: () => void;
  count: () => number | null;
  rememberAdopted: (topicId: string, text: string) => void;
  settleAdopted: (topicId: string, typed: string) => void;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return t('common.networkError');
}

function revWhen(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return new Date(at).toISOString();
  }
}

function adoptDraft(suggestion: string): string {
  return t('reviews.adoptDraft', { suggestion });
}

// Spacing ignored to match the server's preferenceKey normalization.
function carries(sent: string, want: string): boolean {
  const flat = (s: unknown): string => String(s == null ? '' : s).replace(/\s+/g, '');
  const w = flat(want);
  return w.length > 0 && flat(sent).indexOf(w) >= 0;
}

function renderPending(list: readonly ReviewPanelPreference[], text: (s: unknown) => string): string {
  if (!list.length) return '';
  let h =
    '<div class="rev-pending"><div class="rev-label">' +
    text(t('reviews.suggestions', { count: list.length })) +
    '</div>' +
    '<div class="rev-note">' +
    text(t('reviews.suggestionsNote')) +
    '</div>';
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    const from = p.from.map((entry) => entry.title);
    h += '<div class="rev-pitem"><div class="rev-pbody"><div class="rev-ptext">' + text(p.text) + '</div>';
    if (p.reason) h += '<div class="rev-reason">' + text(p.reason) + '</div>';
    h +=
      '<div class="rev-pmeta">' +
      (p.count > 1 ? text(t('reviews.reviewsCount', { count: p.count })) : '') +
      text(from.join(', ')) +
      '</div></div>';
    h +=
      '<div class="rev-pacts">' +
      (p.archive
        ? '<button type="button" class="rev-adopt rev-archive" data-rev-archive="' + i + '">' + text(t('reviews.archive')) + '</button>'
        : '<button type="button" class="rev-adopt" data-rev-adopt="' + i + '">' + text(t('reviews.adopt')) + '</button>') +
      '<button type="button" class="rev-dismiss" data-rev-dismiss="' +
      i +
      '">' + text(t('reviews.dismiss')) + '</button></div></div>';
  }
  return h + '</div>';
}

function renderChange(c: ReviewPanelChange, text: (s: unknown) => string): string {
  const what =
    c.action === 'create'
      ? t('reviews.actionCreate')
      : c.action === 'patch'
        ? t('reviews.actionPatch')
        : c.action === 'archive'
          ? t('reviews.actionArchive')
          : t('reviews.actionWrite');
  const name =
    c.action === 'write-file'
      ? t('reviews.inName', { file: c.file || t('reviews.aFile'), name: c.name })
      : c.action === 'archive' && c.into
        ? t('reviews.intoName', { name: c.name, into: c.into })
        : c.name;
  // applied is three-state: absent means inferred old review or unapplied archive suggestion.
  const status =
    c.applied === true
      ? '<span class="rev-status ok">' + text(t('reviews.statusApplied')) + '</span>'
      : c.applied === false
        ? '<span class="rev-status bad">' + text(t('reviews.statusRefused')) + '</span>'
        : c.suggested
          ? '<span class="rev-status unknown">' + text(t('reviews.statusSuggested')) + '</span>'
          : '<span class="rev-status unknown">' + text(t('reviews.statusUnknown')) + '</span>';
  let h = '<div class="rev-change">' + text(what) + '<span class="rev-name">' + text(name) + '</span>' + status;
  if (c.reason) h += '<div class="rev-reason">' + text(c.reason) + '</div>';
  if (c.error) h += '<div class="rev-note bad">' + text(c.error) + '</div>';
  if (c.undo) h += '<code class="rev-undo">' + text(c.undo) + '</code>';
  if (c.command) h += '<code class="rev-undo">' + text(c.command) + '</code>';
  return h + '</div>';
}

function renderDetail(
  r: ReviewPanelEntry,
  text: (s: unknown) => string,
  topicExists: (id: string) => boolean
): string {
  let h = '<div class="rev-detail">';
  if (r.error) h += '<div class="rev-note bad">' + text(r.error) + '</div>';
  if (r.changes.length) {
    h += '<div class="rev-label">' + text(t('reviews.changes')) + '</div>';
    for (const c of r.changes) h += renderChange(c, text);
  }
  if (r.invalid.length) {
    h += '<div class="rev-label">' + text(t('reviews.rejected')) + '</div>';
    for (const inv of r.invalid) h += '<div class="rev-note">' + text(inv) + '</div>';
  }
  if (r.preferences.length) {
    h += '<div class="rev-label">' + text(t('reviews.preferences')) + '</div>';
    for (const pref of r.preferences) h += '<div class="rev-pref">' + text(pref) + '</div>';
  }
  if (r.inferred) {
    h += '<div class="rev-note">' + text(t('reviews.inferredNote')) + '</div>';
  }
  if (!r.changes.length && !r.preferences.length && !r.invalid.length && !r.error) {
    h += '<div class="rev-note">' + text(t('reviews.nothingChanging')) + '</div>';
  }
  if (r.topic && topicExists(r.topic)) {
    h += '<button type="button" class="rev-open" data-rev-topic="' + text(r.topic) + '">' + text(t('reviews.openTopic')) + '</button>';
  }
  return h + '</div>';
}

function renderRow(
  r: ReviewPanelEntry,
  open: boolean,
  deps: Pick<ReviewsPanelDeps, 'text' | 'schedAgo' | 'topicExists'>
): string {
  const { text, schedAgo, topicExists } = deps;
  let h =
    '<div class="rev-item ' +
    text(r.outcome) +
    (open ? ' open' : '') +
    '" data-rev="' +
    text(r.id) +
    '" role="button" tabindex="0" aria-expanded="' +
    (open ? 'true' : 'false') +
    '">';
  h += '<div class="rev-row"><span class="rev-dot"></span><span class="rev-topic">' + text(r.title) + '</span>';
  if (r.inferred) h += '<span class="rev-badge">' + text(t('reviews.inferredBadge')) + '</span>';
  h += '<span class="rev-when" title="' + text(revWhen(r.at)) + '">' + text(schedAgo(r.at)) + '</span></div>';
  h += '<div class="rev-result">' + text(r.summary) + '</div>';
  if (open) h += renderDetail(r, text, topicExists);
  return h + '</div>';
}

interface ReviewsState {
  data: ReviewPanelList | null;
  seq: number;
  open: Record<string, boolean>;
  adopted: Record<string, { text: string }>;
}

function forgetAdopted(state: ReviewsState, suggestion: string): void {
  for (const id of Object.keys(state.adopted)) {
    if (state.adopted[id]?.text === suggestion) delete state.adopted[id];
  }
}

function paintReviews(state: ReviewsState, deps: ReviewsPanelDeps): void {
  if (state.data === null) {
    deps.revList.innerHTML = '<div class="sched-empty">' + deps.text(t('common.loading')) + '</div>';
    return;
  }
  if (!state.data.enabled) {
    deps.revList.innerHTML = '<div class="sched-empty">' + deps.text(t('reviews.noLibrary')) + '</div>';
    return;
  }
  if (!state.data.reviews.length) {
    deps.revList.innerHTML =
      '<div class="sched-empty">' +
      deps.text(state.data.running ? t('reviews.emptyRunning') : t('reviews.emptyOff')) +
      '</div>';
    return;
  }
  let h = renderPending(state.data.pending || [], deps.text);
  for (const r of state.data.reviews) h += renderRow(r, Boolean(state.open[r.id]), deps);
  deps.revList.innerHTML = h;
}

function loadReviews(state: ReviewsState, deps: ReviewsPanelDeps): void {
  if (deps.app.hidden) return;
  const seq = ++state.seq;
  fetch('api/reviews', { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json() as Promise<ReviewPanelList | null>;
    })
    .then((d) => {
      if (seq !== state.seq) return;
      state.data = d || { enabled: false, running: false, reviews: [], pending: [] };
      paintReviews(state, deps);
      deps.paintCounts();
      deps.paintSummary();
    })
    .catch((e: unknown) => {
      if (seq !== state.seq) return;
      deps.showNote(t('reviews.refreshFailed', { err: errorMessage(e) }));
    });
}

function dismissSuggestion(
  state: ReviewsState,
  deps: ReviewsPanelDeps,
  p: { text: string },
  btn: HTMLButtonElement | null
): void {
  if (btn) btn.disabled = true;
  const body: ReviewOpRequest = { action: 'dismiss', text: p.text };
  deps
    .post('api/reviews/op', body, 1)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json() as Promise<ReviewPanelList | null>;
    })
    .then((d) => {
      // Bump sequence so an earlier in-flight list refresh cannot put the dismissed item back.
      state.seq++;
      state.data = d || state.data;
      forgetAdopted(state, p.text);
      paintReviews(state, deps);
      deps.paintCounts();
    })
    .catch((e: unknown) => {
      if (btn) btn.disabled = false;
      deps.showNote(t('reviews.dismissFailed', { err: errorMessage(e) }));
    });
}

function archiveSuggested(state: ReviewsState, deps: ReviewsPanelDeps, btn: HTMLButtonElement): void {
  const p = state.data?.pending?.[Number(btn.getAttribute('data-rev-archive'))];
  if (!p?.archive) return;
  const skillName = p.archive.name;
  btn.disabled = true;
  deps.beforeSkillArchive();
  const body: SkillOpRequest = { action: 'archive', name: skillName };
  deps
    .post('api/skills/op', body, 1)
    .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<{ ok?: boolean; error?: string }>)
    .then((d) => {
      if (!d || !d.ok) throw new Error((d && d.error) || t('reviews.archiveRefused'));
      loadReviews(state, deps);
      deps.afterSkillArchive(true);
    })
    .catch((e: unknown) => {
      btn.disabled = false;
      deps.showNote(t('reviews.archiveFailed', { name: skillName, err: errorMessage(e) }));
      deps.afterSkillArchive(false);
    });
}

function adoptPreference(state: ReviewsState, deps: ReviewsPanelDeps, btn: HTMLButtonElement): void {
  const p = state.data?.pending?.[Number(btn.getAttribute('data-rev-adopt'))];
  if (!p) return;
  btn.disabled = true;
  deps.createTopic({ text: p.text, draft: adoptDraft(p.text) }).then(
    () => {
      btn.disabled = false;
    },
    () => {
      btn.disabled = false;
    }
  );
}

function bindReviewEvents(state: ReviewsState, deps: ReviewsPanelDeps): void {
  deps.revList.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const adoptBtn = target.closest<HTMLButtonElement>('[data-rev-adopt]');
    if (adoptBtn) {
      e.stopPropagation();
      adoptPreference(state, deps, adoptBtn);
      return;
    }
    const archiveBtn = target.closest<HTMLButtonElement>('[data-rev-archive]');
    if (archiveBtn) {
      e.stopPropagation();
      archiveSuggested(state, deps, archiveBtn);
      return;
    }
    const dismissBtn = target.closest<HTMLButtonElement>('[data-rev-dismiss]');
    if (dismissBtn) {
      e.stopPropagation();
      const p = state.data?.pending?.[Number(dismissBtn.getAttribute('data-rev-dismiss'))];
      if (p) dismissSuggestion(state, deps, p, dismissBtn);
      return;
    }
    const openBtn = target.closest('[data-rev-topic]');
    if (openBtn) {
      e.stopPropagation();
      const topicId = openBtn.getAttribute('data-rev-topic');
      if (topicId) deps.switchTopic(topicId);
      return;
    }
    const id = target.closest('[data-rev]')?.getAttribute('data-rev');
    if (!id) return;
    state.open[id] = !state.open[id];
    paintReviews(state, deps);
  });

  deps.revList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('[data-rev-topic]')) return;
    const id = target.closest('[data-rev]')?.getAttribute('data-rev');
    if (!id) return;
    e.preventDefault();
    state.open[id] = !state.open[id];
    paintReviews(state, deps);
  });
}

export function createReviewsPanel(deps: ReviewsPanelDeps): ReviewsPanel {
  const state: ReviewsState = { data: null, seq: 0, open: {}, adopted: {} };
  bindReviewEvents(state, deps);

  return {
    load: () => loadReviews(state, deps),
    paint: () => paintReviews(state, deps),
    count: () => (state.data ? state.data.reviews.length : null),
    rememberAdopted: (topicId, suggestion) => {
      state.adopted[topicId] = { text: suggestion };
    },
    settleAdopted: (topicId, typed) => {
      const a = state.adopted[topicId];
      if (!a || !carries(typed, a.text)) return;
      dismissSuggestion(state, deps, a, null);
    },
  };
}

import type { SettingsScreen, SettingsScreenField, SettingsScreenRow } from '../../../../../types.js';

export interface SettingBaselineEntry {
  readonly key: string;
  readonly kind: 'switch' | 'choice' | 'list';
  readonly value: string;
  readonly on?: boolean;
  readonly optionLabel?: string;
}

export interface SettingModifiedInfo {
  readonly key: string;
  readonly initialValue: string;
  readonly currentValue: string;
  readonly resetButtonId?: string;
}

export interface SettingsFilterCounts {
  readonly matched: number;
  readonly total: number;
}

export function rowBaselineKey(row: SettingsScreenRow): string {
  return `${row.group ?? ''}::${row.target ?? ''}::${row.label}`;
}

export function fieldBaselineKey(row: SettingsScreenRow, field: SettingsScreenField): string {
  return `${row.group ?? ''}::${row.target ?? row.label}::field::${field.label}`;
}

function readRowValue(row: SettingsScreenRow): SettingBaselineEntry | null {
  const c = row.control || { kind: 'list' as const };
  if (c.kind === 'agent' || c.kind === 'link') return null;
  const key = rowBaselineKey(row);
  if (c.kind === 'switch') {
    return { key, kind: 'switch', value: c.on ? 'on' : 'off', on: Boolean(c.on) };
  }
  if (c.kind === 'choice') {
    const cur = (c.options || []).find((o) => o.current);
    const label = cur ? cur.label : String(row.value ?? '');
    return { key, kind: 'choice', value: label, optionLabel: label };
  }
  return { key, kind: 'list', value: row.unset ? '' : String(row.value ?? '') };
}

function readFieldValue(row: SettingsScreenRow, field: SettingsScreenField): SettingBaselineEntry {
  const c = field.control || { kind: 'list' as const };
  const key = fieldBaselineKey(row, field);
  if (c.kind === 'choice') {
    const cur = (c.options || []).find((o) => o.current);
    const label = cur ? cur.label : String(field.value ?? '');
    return { key, kind: 'choice', value: label, optionLabel: label };
  }
  return { key, kind: 'list', value: field.unset ? '' : String(field.value ?? '') };
}

/**
 * Records initial loaded values for every setting row/agent field in a list screen.
 * Existing baseline keys are preserved so subsequent updates can be compared against initial values.
 */
export function captureBaseline(
  screen: Extract<SettingsScreen, { level: 'list' }>,
  baseline: Map<string, SettingBaselineEntry>,
): void {
  for (const row of screen.rows || []) {
    if (row.control?.kind === 'agent') {
      for (const field of row.control.fields || []) {
        const entry = readFieldValue(row, field);
        if (!baseline.has(entry.key)) baseline.set(entry.key, entry);
      }
      continue;
    }
    const entry = readRowValue(row);
    if (entry && !baseline.has(entry.key)) baseline.set(entry.key, entry);
  }
}

function resolveChoiceResetButton(
  options: readonly { label: string; buttonId: string }[] | undefined,
  initialLabel: string,
): string | undefined {
  if (!options) return undefined;
  return options.find((o) => o.label === initialLabel)?.buttonId;
}

function collectAgentFieldModifications(
  row: SettingsScreenRow,
  baseline: ReadonlyMap<string, SettingBaselineEntry>,
  out: Map<string, SettingModifiedInfo>,
): void {
  if (row.control?.kind !== 'agent') return;
  for (const field of row.control.fields || []) {
    const current = readFieldValue(row, field);
    const init = baseline.get(current.key);
    if (!init || init.value === current.value) continue;
    const resetButtonId =
      field.control?.kind === 'choice'
        ? resolveChoiceResetButton(field.control.options, init.optionLabel ?? init.value)
        : undefined;
    out.set(current.key, {
      key: current.key,
      initialValue: init.value,
      currentValue: current.value,
      resetButtonId,
    });
  }
}

function resolveRowResetButton(row: SettingsScreenRow, init: SettingBaselineEntry): string | undefined {
  if (row.control?.kind === 'switch') return row.control.set;
  if (row.control?.kind === 'choice') {
    return resolveChoiceResetButton(row.control.options, init.optionLabel ?? init.value);
  }
  return undefined;
}

/**
 * Computes the map of currently modified settings (rows and agent fields that deviate from their
 * initial baseline values) along with their reset button IDs where direct reset is supported.
 */
export function computeModifiedMap(
  screen: Extract<SettingsScreen, { level: 'list' }>,
  baseline: ReadonlyMap<string, SettingBaselineEntry>,
): Map<string, SettingModifiedInfo> {
  const out = new Map<string, SettingModifiedInfo>();
  for (const row of screen.rows || []) {
    if (row.control?.kind === 'agent') {
      collectAgentFieldModifications(row, baseline, out);
      continue;
    }
    const current = readRowValue(row);
    if (!current) continue;
    const init = baseline.get(current.key);
    if (!init || init.value === current.value) continue;
    out.set(current.key, {
      key: current.key,
      initialValue: init.value,
      currentValue: current.value,
      resetButtonId: resolveRowResetButton(row, init),
    });
  }
  return out;
}

export function matchesSearchWords(haystack: string, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const lower = haystack.toLowerCase();
  for (const w of words) {
    if (!lower.includes(w)) return false;
  }
  return true;
}

export function tokenizeQuery(raw: string): string[] {
  const trimmed = raw.trim().toLowerCase();
  return trimmed ? trimmed.split(/\s+/) : [];
}

function attachModifiedChrome(
  doc: Document,
  targetEl: HTMLElement,
  info: SettingModifiedInfo,
  labels: { modifiedBadge: string; resetLabel: string; initialTitle: (v: string) => string },
): void {
  targetEl.classList.add('is-modified');
  targetEl.setAttribute('data-modified', 'true');
  targetEl.setAttribute('data-setting-key', info.key);

  const labelContainer =
    targetEl.querySelector<HTMLElement>('.set-label') ??
    targetEl.querySelector<HTMLElement>('.ag-lab');
  if (labelContainer && !labelContainer.querySelector('.wb-set-mod-badge')) {
    const badge = doc.createElement('span');
    badge.className = 'wb-set-mod-badge';
    badge.textContent = labels.modifiedBadge;
    badge.title = labels.initialTitle(info.initialValue);
    labelContainer.appendChild(badge);
  }

  if (info.resetButtonId && !targetEl.querySelector('.wb-set-reset-btn')) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'wb-set-reset-btn';
    btn.setAttribute('data-reset-btn', info.resetButtonId);
    btn.setAttribute('data-setting-key', info.key);
    btn.title = labels.initialTitle(info.initialValue);
    btn.textContent = labels.resetLabel;
    const host =
      targetEl.querySelector<HTMLElement>('.set-ctl') ??
      targetEl.querySelector<HTMLElement>('.ag-val');
    if (host) host.appendChild(btn);
  }
}

function findAgentCard(gatewayBodyEl: HTMLElement, agId: string): HTMLElement | null {
  const cards = gatewayBodyEl.querySelectorAll<HTMLElement>('.ag-card');
  for (let c = 0; c < cards.length; c++) {
    if (cards[c]?.getAttribute('data-ag') === agId) return cards[c] ?? null;
  }
  return null;
}

function decorateAgentCard(
  doc: Document,
  gatewayBodyEl: HTMLElement,
  row: SettingsScreenRow,
  modified: ReadonlyMap<string, SettingModifiedInfo>,
  labels: { modifiedBadge: string; resetLabel: string; initialTitle: (v: string) => string },
): void {
  if (row.control?.kind !== 'agent') return;
  const card = findAgentCard(gatewayBodyEl, String(row.target || row.label));
  if (!card) return;
  let agentModified = false;
  const fields = row.control.fields || [];
  const fieldEls = card.querySelectorAll<HTMLElement>('.ag-field:not(.ag-instr)');
  for (let fIdx = 0; fIdx < fields.length; fIdx++) {
    const field = fields[fIdx];
    const fieldEl = fieldEls[fIdx];
    if (!field || !fieldEl) continue;
    const info = modified.get(fieldBaselineKey(row, field));
    if (!info) continue;
    agentModified = true;
    attachModifiedChrome(doc, fieldEl, info, labels);
  }
  if (agentModified) {
    card.classList.add('is-modified');
    card.setAttribute('data-modified', 'true');
  }
}

/**
 * Decorates rendered gateway settings DOM with modified bars, badges, and reset buttons.
 */
export function applyModifiedIndicators(
  doc: Document,
  gatewayBodyEl: HTMLElement,
  screen: Extract<SettingsScreen, { level: 'list' }>,
  modified: ReadonlyMap<string, SettingModifiedInfo>,
  labels: { modifiedBadge: string; resetLabel: string; initialTitle: (v: string) => string },
): void {
  const rows = screen.rows || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.control?.kind === 'agent') {
      decorateAgentCard(doc, gatewayBodyEl, row, modified, labels);
      continue;
    }
    const info = modified.get(rowBaselineKey(row));
    if (!info) continue;
    const controlEl = gatewayBodyEl.querySelector<HTMLElement>(`[data-fk="r${i}"], [data-fk="r${i}o0"]`);
    const itemEl = controlEl?.closest<HTMLElement>('.set-item');
    if (itemEl) attachModifiedChrome(doc, itemEl, info, labels);
  }
}

function filterSectionCards(
  sec: HTMLElement,
  groupText: string,
  groupHit: boolean,
  words: readonly string[],
  modifiedOnly: boolean,
): SettingsFilterCounts {
  let total = 0;
  let matched = 0;
  const cards = sec.querySelectorAll<HTMLElement>('.set-card');
  for (let c = 0; c < cards.length; c++) {
    const card = cards[c];
    if (!card) continue;
    let cardVisible = 0;
    const items = card.querySelectorAll<HTMLElement>('.set-item');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      total++;
      const show =
        (groupHit || matchesSearchWords(`${groupText} ${item.textContent ?? ''}`, words)) &&
        (!modifiedOnly || item.classList.contains('is-modified'));
      item.hidden = !show;
      if (show) {
        cardVisible++;
        matched++;
      }
    }
    card.hidden = cardVisible === 0;
  }
  return { matched, total };
}

function filterSectionAgents(
  sec: HTMLElement,
  groupText: string,
  groupHit: boolean,
  words: readonly string[],
  modifiedOnly: boolean,
): SettingsFilterCounts {
  let total = 0;
  let matched = 0;
  const agCards = sec.querySelectorAll<HTMLElement>('.ag-card');
  for (let a = 0; a < agCards.length; a++) {
    const ag = agCards[a];
    if (!ag) continue;
    total++;
    const show =
      (groupHit || matchesSearchWords(`${groupText} ${ag.textContent ?? ''}`, words)) &&
      (!modifiedOnly || ag.classList.contains('is-modified'));
    ag.hidden = !show;
    if (show) matched++;
  }
  return { matched, total };
}

function filterGatewaySections(
  gatewayBodyEl: HTMLElement,
  words: readonly string[],
  modifiedOnly: boolean,
): SettingsFilterCounts {
  let total = 0;
  let matched = 0;
  const sections = gatewayBodyEl.querySelectorAll<HTMLElement>('.set-sec');
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    if (!sec) continue;
    const groupText = sec.querySelector<HTMLElement>('.set-group')?.textContent ?? '';
    const groupHit = words.length > 0 && matchesSearchWords(groupText, words);
    const cardRes = filterSectionCards(sec, groupText, groupHit, words, modifiedOnly);
    const agRes = filterSectionAgents(sec, groupText, groupHit, words, modifiedOnly);
    const secVisible = cardRes.matched + agRes.matched;
    total += cardRes.total + agRes.total;
    matched += secVisible;
    sec.hidden = secVisible === 0 && (words.length > 0 || modifiedOnly);
  }
  return { matched, total };
}

function filterDeviceSections(
  deviceWrapEl: HTMLElement,
  deviceListEl: HTMLElement,
  words: readonly string[],
  modifiedOnly: boolean,
): SettingsFilterCounts {
  const secs = deviceListEl.querySelectorAll<HTMLElement>('.wb-set-device-sec');
  if (secs.length === 0) return { matched: 0, total: 0 };
  let total = 0;
  let matched = 0;
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    if (!sec) continue;
    total++;
    const hay = `${sec.getAttribute('data-section-id') ?? ''} ${sec.textContent ?? ''}`;
    const show = !modifiedOnly && matchesSearchWords(hay, words);
    sec.hidden = !show;
    if (show) matched++;
  }
  deviceWrapEl.hidden = matched === 0;
  return { matched, total };
}

/**
 * Applies live keyword and modified-only filtering across both gateway and device settings sections.
 */
export function applySettingsFilter(
  gatewayBodyEl: HTMLElement,
  deviceWrapEl: HTMLElement,
  deviceListEl: HTMLElement,
  query: string,
  modifiedOnly: boolean,
): SettingsFilterCounts {
  const words = tokenizeQuery(query);
  const gw = filterGatewaySections(gatewayBodyEl, words, modifiedOnly);
  const dev = filterDeviceSections(deviceWrapEl, deviceListEl, words, modifiedOnly);
  return { matched: gw.matched + dev.matched, total: gw.total + dev.total };
}

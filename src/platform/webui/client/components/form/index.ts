import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { icon } from '../../../icons.js';
import { html, nothing, type TemplateResult } from '../../base/html.js';
import { type IconInput, renderIcon } from '../shared.js';
import { renderSegmented, type SegmentedOption } from '../tabs/index.js';

export interface FieldRowOptions {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly warning?: string | null;
  readonly required?: boolean;
  readonly inline?: boolean;
  readonly control: TemplateResult;
  readonly className?: string;
}

export interface TextInputOptions {
  readonly id?: string;
  readonly name?: string;
  readonly type?: 'text' | 'password' | 'search' | 'url' | 'number';
  readonly value: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly readonly?: boolean;
  readonly invalid?: boolean;
  readonly autocomplete?: string;
  readonly className?: string;
  readonly onInput?: (value: string, ev: Event) => void;
  readonly onChange?: (value: string, ev: Event) => void;
}

export interface SwitchOptions {
  readonly id?: string;
  readonly checked: boolean;
  readonly label?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onChange: (checked: boolean) => void;
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectOptions {
  readonly id?: string;
  readonly name?: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly className?: string;
  readonly onChange: (value: string, ev: Event) => void;
}

export interface SegmentedFieldOptions {
  readonly options: readonly SegmentedOption[];
  readonly value: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly onChange: (value: string) => void;
}

export function renderFieldRow(opts: FieldRowOptions): TemplateResult {
  const hasError = Boolean(opts.error);
  const hasWarn = !hasError && Boolean(opts.warning);
  const cls =
    `fh-field${opts.inline ? ' fh-field--inline' : ''}` +
    `${hasError ? ' is-invalid' : ''}` +
    `${opts.className ? ` ${opts.className}` : ''}`;
  const msgId = opts.id ? `${opts.id}-msg` : undefined;
  return html`<div class=${cls}>
    <div class="fh-field-head">
      <label class="fh-field-label" for=${opts.id ?? nothing}>
        ${opts.label}${opts.required ? html`<span class="fh-field-req" aria-hidden="true">*</span>` : nothing}
      </label>
      ${opts.hint ? html`<div class="fh-field-hint">${opts.hint}</div>` : nothing}
    </div>
    <div class="fh-field-control">${opts.control}</div>
    ${hasError
      ? html`<div class="fh-field-msg fh-field-msg--err" id=${msgId ?? nothing} role="alert">${opts.error}</div>`
      : hasWarn
        ? html`<div class="fh-field-msg fh-field-msg--warn" id=${msgId ?? nothing} role="status">${opts.warning}</div>`
        : nothing}
  </div>`;
}

export function renderTextInput(opts: TextInputOptions): TemplateResult {
  const cls = `fh-input${opts.invalid ? ' is-invalid' : ''}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<input
    class=${cls}
    id=${opts.id ?? nothing}
    name=${opts.name ?? nothing}
    type=${opts.type ?? 'text'}
    .value=${opts.value}
    placeholder=${opts.placeholder ?? nothing}
    aria-label=${opts.ariaLabel ?? nothing}
    aria-invalid=${opts.invalid ? 'true' : nothing}
    autocomplete=${opts.autocomplete ?? 'off'}
    ?disabled=${Boolean(opts.disabled)}
    ?readonly=${Boolean(opts.readonly)}
    @input=${(ev: Event) => opts.onInput?.((ev.currentTarget as HTMLInputElement).value, ev)}
    @change=${(ev: Event) => opts.onChange?.((ev.currentTarget as HTMLInputElement).value, ev)}
  />`;
}

export function renderSwitch(opts: SwitchOptions): TemplateResult {
  const cls = `fh-switch${opts.checked ? ' is-checked' : ''}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<button
    type="button"
    class=${cls}
    id=${opts.id ?? nothing}
    role="switch"
    aria-checked=${opts.checked ? 'true' : 'false'}
    aria-label=${opts.ariaLabel ?? opts.label ?? nothing}
    ?disabled=${Boolean(opts.disabled)}
    @click=${() => {
      if (!opts.disabled) opts.onChange(!opts.checked);
    }}
  >
    <span class="fh-switch-track" aria-hidden="true"><span class="fh-switch-thumb"></span></span>
    ${opts.label ? html`<span class="fh-switch-label">${opts.label}</span>` : nothing}
  </button>`;
}

export function renderSelect(opts: SelectOptions): TemplateResult {
  const cls = `fh-select${opts.invalid ? ' is-invalid' : ''}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<select
    class=${cls}
    id=${opts.id ?? nothing}
    name=${opts.name ?? nothing}
    aria-label=${opts.ariaLabel ?? nothing}
    aria-invalid=${opts.invalid ? 'true' : nothing}
    ?disabled=${Boolean(opts.disabled)}
    .value=${opts.value}
    @change=${(ev: Event) => opts.onChange((ev.currentTarget as HTMLSelectElement).value, ev)}
  >
    ${opts.options.map(
      (opt) => html`<option value=${opt.value} ?disabled=${Boolean(opt.disabled)} ?selected=${opt.value === opts.value}>${opt.label}</option>`,
    )}
  </select>`;
}

export function renderSegmentedField(opts: SegmentedFieldOptions): TemplateResult {
  return renderSegmented({
    options: opts.options,
    value: opts.value,
    kind: 'value',
    ariaLabel: opts.ariaLabel,
    className: opts.className,
    onChange: opts.onChange,
  });
}

export interface RadioOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface RadioGroupOptions {
  readonly options: readonly RadioOption[];
  readonly value: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly onChange: (value: string) => void;
}

export interface GroupedListItem {
  readonly id?: string;
  readonly label: string | TemplateResult;
  readonly subtitle?: string | TemplateResult;
  readonly value?: string | TemplateResult;
  readonly icon?: IconInput;
  readonly iconBox?: boolean;
  readonly trailing?: TemplateResult;
  readonly chevron?: boolean;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly link?: boolean;
  readonly onClick?: () => void;
}

export interface GroupedListOptions {
  readonly header?: string;
  readonly footer?: string;
  readonly items: readonly GroupedListItem[];
  readonly className?: string;
}

function renderCheckIcon(): TemplateResult {
  return html`${unsafeHTML(icon('check', 'fh-mgroup-check'))}`;
}

function renderChevronIcon(): TemplateResult {
  return html`${unsafeHTML(icon('chevronRight', 'fh-mgroup-chev'))}`;
}

export function renderRadioGroup(opts: RadioGroupOptions): TemplateResult {
  const cls = `fh-mgroup fh-radio-group${opts.className ? ` ${opts.className}` : ''}`;
  return html`<div class=${cls} role="radiogroup" aria-label=${opts.ariaLabel ?? nothing}>
    ${opts.options.map((opt) => {
      const checked = opt.value === opts.value;
      const rowCls =
        `fh-mgroup-item fh-radio-item${checked ? ' is-selected' : ''}` +
        `${opt.disabled ? ' is-disabled' : ''}`;
      return html`<button
        type="button"
        class=${rowCls}
        role="radio"
        data-radio-value=${opt.value}
        aria-checked=${checked ? 'true' : 'false'}
        ?disabled=${Boolean(opt.disabled)}
        @click=${() => {
          if (!opt.disabled) opts.onChange(opt.value);
        }}
      >
        <span class="fh-mgroup-main">
          <span class="fh-mgroup-label">${opt.label}</span>
          ${opt.description ? html`<small class="fh-mgroup-sub">${opt.description}</small>` : nothing}
        </span>
        ${checked ? renderCheckIcon() : nothing}
      </button>`;
    })}
  </div>`;
}

export function renderGroupedList(opts: GroupedListOptions): TemplateResult {
  const cls = `fh-mgroup-section${opts.className ? ` ${opts.className}` : ''}`;
  return html`<section class=${cls}>
    ${opts.header ? html`<div class="fh-mgroup-head">${opts.header}</div>` : nothing}
    <div class="fh-mgroup">
      ${opts.items.map((item) => {
        const itemCls =
          `fh-mgroup-item${item.disabled ? ' is-disabled' : ''}` +
          `${item.danger ? ' is-danger' : ''}` +
          `${item.link ? ' is-link' : ''}` +
          `${item.onClick && !item.disabled ? ' is-clickable' : ''}`;
        const iconEl = item.icon
          ? item.iconBox
            ? html`<span class="fh-mgroup-icbox">${renderIcon(item.icon, 'fh-icon')}</span>`
            : renderIcon(item.icon, 'fh-mgroup-icon')
          : nothing;
        const content = html`
          ${iconEl}
          <span class="fh-mgroup-main">
            <span class="fh-mgroup-label">${item.label}</span>
            ${item.subtitle ? html`<small class="fh-mgroup-sub">${item.subtitle}</small>` : nothing}
          </span>
          ${item.value !== undefined ? html`<span class="fh-mgroup-val">${item.value}</span>` : nothing}
          ${item.trailing ?? nothing}
          ${item.chevron ? renderChevronIcon() : nothing}
        `;
        if (item.onClick) {
          return html`<button
            type="button"
            class=${itemCls}
            data-group-item=${item.id ?? nothing}
            ?disabled=${Boolean(item.disabled)}
            @click=${() => {
              if (!item.disabled) item.onClick?.();
            }}
          >${content}</button>`;
        }
        return html`<div class=${itemCls} data-group-item=${item.id ?? nothing}>${content}</div>`;
      })}
    </div>
    ${opts.footer ? html`<div class="fh-mgroup-foot">${opts.footer}</div>` : nothing}
  </section>`;
}

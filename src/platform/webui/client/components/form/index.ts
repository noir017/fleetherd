import { html, nothing, type TemplateResult } from '../../base/html.js';
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

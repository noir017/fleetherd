// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { html, render } from '../../base/html.js';
import {
  renderFieldRow,
  renderSegmentedField,
  renderSelect,
  renderSwitch,
  renderTextInput,
} from './index.js';

describe('components/form', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders field rows, text input, switch, select, and value segmented control', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onInput = vi.fn();
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const onSeg = vi.fn();

    render(
      html`
        ${renderFieldRow({
          id: 'name',
          label: 'Name',
          hint: 'Visible in sidebar',
          error: 'Required',
          required: true,
          control: renderTextInput({ id: 'name', value: '', invalid: true, onInput }),
        })}
        ${renderSwitch({ checked: false, label: 'Low attention', onChange: onToggle })}
        ${renderSelect({
          value: 'dark',
          options: [
            { value: 'system', label: 'System' },
            { value: 'dark', label: 'Dark' },
          ],
          onChange: onSelect,
        })}
        ${renderSegmentedField({
          value: 'auto',
          options: [
            { value: 'ask', label: 'ask' },
            { value: 'auto', label: 'auto' },
          ],
          onChange: onSeg,
        })}
      `,
      host,
    );

    expect(host.querySelector('.fh-field-msg--err')?.textContent).toBe('Required');
    const input = host.querySelector<HTMLInputElement>('#name')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = 'demo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onInput).toHaveBeenCalledWith('demo', expect.any(Event));

    const sw = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    expect(onToggle).toHaveBeenCalledWith(true);

    const sel = host.querySelector<HTMLSelectElement>('select')!;
    sel.value = 'system';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('system', expect.any(Event));

    expect(host.querySelector('.fh-seg--value')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[data-seg-value="ask"]')!.click();
    expect(onSeg).toHaveBeenCalledWith('ask');
  });
});

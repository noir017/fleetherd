// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import { createActionBar, createSidebarActionBarHost } from './index.js';

describe('components/actionbar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders variants, tooltips, disabled/active states, and dispatches click callbacks', () => {
    const onSave = vi.fn();
    const onAction = vi.fn();
    const bar = createActionBar({
      ariaLabel: 'Editor actions',
      items: [
        { id: 'save', label: 'Save', variant: 'primary', title: 'Save file', onClick: onSave },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
        { id: 'more', icon: '<svg class="ic"></svg>', title: 'More' },
      ],
      onAction,
    });
    document.body.appendChild(bar.el);

    const saveBtn = bar.el.querySelector<HTMLButtonElement>('[data-action-id="save"]')!;
    const moreBtn = bar.el.querySelector<HTMLButtonElement>('[data-action-id="more"]')!;
    expect(saveBtn.classList.contains('fh-btn--primary')).toBe(true);
    expect(moreBtn.classList.contains('fh-btn--icon')).toBe(true);
    expect(moreBtn.getAttribute('aria-label')).toBe('More');

    saveBtn.click();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('save', expect.objectContaining({ type: 'click' }));

    bar.setDisabled('save', true);
    expect(saveBtn.disabled).toBe(true);

    bar.setActive('more', true);
    expect(moreBtn.classList.contains('is-active')).toBe(true);
    expect(moreBtn.getAttribute('aria-pressed')).toBe('true');

    bar.dispose();
  });

  it('hosts a view ActionBar in .wb-sidebar-head > .wb-part-actions while visible and cleans up on hide/switch/dispose', () => {
    const sidebar = document.createElement('aside');
    sidebar.className = 'wb-sidebar';
    const head = document.createElement('div');
    head.className = 'wb-part-head wb-sidebar-head';
    const actions = document.createElement('div');
    actions.className = 'wb-part-actions';
    const body = document.createElement('div');
    body.className = 'wb-sidebar-body';
    head.appendChild(actions);
    sidebar.append(head, body);
    document.body.appendChild(sidebar);

    const viewA = document.createElement('div');
    const viewB = document.createElement('div');
    const fallbackB = document.createElement('div');
    viewB.appendChild(fallbackB);
    body.append(viewA, viewB);

    const barA = createActionBar({ items: [{ id: 'a.refresh', title: 'Refresh A' }] });
    const barB = createActionBar({ items: [{ id: 'b.refresh', title: 'Refresh B' }] });
    const visA = new Emitter<boolean>();
    const visB = new Emitter<boolean>();

    const hostA = createSidebarActionBarHost({
      viewEl: viewA,
      actionBarEl: barA.el,
      api: { isVisible: true, onDidVisibilityChange: visA.event },
    });
    const hostB = createSidebarActionBarHost({
      viewEl: viewB,
      actionBarEl: barB.el,
      fallbackHost: fallbackB,
      api: { isVisible: false, onDidVisibilityChange: visB.event },
    });

    expect(hostA.isHostedInTitleBar()).toBe(true);
    expect(actions.querySelectorAll('[data-action-id]').length).toBe(1);
    expect(actions.querySelector('[data-action-id="a.refresh"]')).not.toBeNull();
    expect(fallbackB.contains(barB.el)).toBe(true);
    expect(fallbackB.hidden).toBe(false);

    // Switch from A to B
    visA.fire(false);
    visB.fire(true);
    expect(hostA.isHostedInTitleBar()).toBe(false);
    expect(hostB.isHostedInTitleBar()).toBe(true);
    expect(actions.querySelector('[data-action-id="a.refresh"]')).toBeNull();
    expect(actions.querySelector('[data-action-id="b.refresh"]')).not.toBeNull();
    expect(fallbackB.hidden).toBe(true);

    // Dispose B removes its bar from the title bar
    hostB.dispose();
    expect(actions.querySelector('[data-action-id="b.refresh"]')).toBeNull();
    expect(actions.children.length).toBe(0);

    hostA.dispose();
    barA.dispose();
    barB.dispose();
    visA.dispose();
    visB.dispose();
  });
});

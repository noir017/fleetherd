// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyState, createNotice } from './index.js';

describe('components/notice', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders tone, alert role, and supports dismissible notices', () => {
    const onDismiss = vi.fn();
    const notice = createNotice({
      tone: 'err',
      title: 'Save failed',
      message: 'Conflict detected',
      dismissible: true,
      onDismiss,
    });
    document.body.appendChild(notice.el);

    const box = notice.el.querySelector('.fh-notice')!;
    expect(box.classList.contains('fh-notice--err')).toBe(true);
    expect(box.getAttribute('role')).toBe('alert');
    expect(notice.el.querySelector('.fh-notice-title')?.textContent).toBe('Save failed');

    notice.el.querySelector<HTMLButtonElement>('.fh-notice-dismiss')!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(notice.el.hidden).toBe(true);

    notice.dispose();
  });

  it('renders EmptyState with action button', () => {
    const onClick = vi.fn();
    const empty = createEmptyState({
      title: 'Nothing here',
      description: 'Create your first task',
      action: { label: 'New task', variant: 'primary', onClick },
    });
    document.body.appendChild(empty.el);

    expect(empty.el.querySelector('.fh-empty-title')?.textContent).toBe('Nothing here');
    empty.el.querySelector<HTMLButtonElement>('.fh-btn--primary')!.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    empty.dispose();
  });
});

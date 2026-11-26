// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { formatBadgeCount, mountBadge, mountStatusDot, mountTag } from './index.js';

describe('components/badge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('formats and renders capsule count badges and dot badges', () => {
    expect(formatBadgeCount(120, 99)).toBe('99+');
    const host = document.createElement('div');
    mountBadge(host, { count: 120, max: 99, tone: 'accent' });
    expect(host.querySelector('.fh-badge')?.textContent).toBe('99+');

    mountBadge(host, { dot: true, tone: 'warn', title: 'Attention' });
    const dot = host.querySelector('.fh-badge--dot');
    expect(dot?.classList.contains('fh-badge--warn')).toBe(true);
    expect(dot?.getAttribute('aria-label')).toBe('Attention');

    mountBadge(host, { count: null });
    expect(host.querySelector('.fh-badge')).toBeNull();
  });

  it('renders harness tags and pulsing status dots', () => {
    const host = document.createElement('div');
    mountTag(host, { label: 'claude', harness: 'claude' });
    const tag = host.querySelector('.fh-tag');
    expect(tag?.classList.contains('fh-tag--hc-claude')).toBe(true);
    expect(tag?.textContent).toBe('claude');

    mountTag(host, { label: 'Custom', harness: 'unknown-harness', tone: 'ok' });
    expect(host.querySelector('.fh-tag')?.classList.contains('fh-tag--ok')).toBe(true);

    mountStatusDot(host, { status: 'ok', pulsing: true, label: 'Running' });
    const dot = host.querySelector('.fh-dot');
    expect(dot?.classList.contains('fh-dot--ok')).toBe(true);
    expect(dot?.classList.contains('is-pulsing')).toBe(true);
    expect(dot?.getAttribute('aria-label')).toBe('Running');
  });
});

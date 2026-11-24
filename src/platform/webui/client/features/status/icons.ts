import { svg, type SVGTemplateResult } from '../../base/html.js';

export type StatusIconName =
  | 'play'
  | 'pause'
  | 'bell'
  | 'moon'
  | 'sun'
  | 'monitor'
  | 'globe'
  | 'refresh'
  | 'alert'
  | 'cross';

function iconBody(name: StatusIconName): SVGTemplateResult {
  switch (name) {
    case 'play':
      return svg`<path d="M8 5.5v13l10-6.5z"/>`;
    case 'pause':
      return svg`<path d="M9 5.5v13M15 5.5v13"/>`;
    case 'bell':
      return svg`<path d="M6 9a6 6 0 0 1 12 0c0 3.6 1.2 5.2 2.2 6.3H3.8C4.8 14.2 6 12.6 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>`;
    case 'moon':
      return svg`<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>`;
    case 'sun':
      return svg`<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>`;
    case 'monitor':
      return svg`<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>`;
    case 'globe':
      return svg`<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/>`;
    case 'refresh':
      return svg`<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 3.5V9H15"/>`;
    case 'alert':
      return svg`<path d="M12 3.5 2.5 19.5h19L12 3.5z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none"/>`;
    case 'cross':
      return svg`<path d="M6 6l12 12M18 6 6 18"/>`;
  }
}

export function renderStatusIcon(name: StatusIconName, extraClass?: string): SVGTemplateResult {
  const cls = `ic ic-${name}${extraClass ? ` ${extraClass}` : ''}`;
  return svg`<svg
    class=${cls}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >${iconBody(name)}</svg>`;
}

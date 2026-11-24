import { svg, type SVGTemplateResult } from '../../base/html.js';

export type PaletteIconName =
  | 'search'
  | 'command'
  | 'keyboard'
  | 'topic'
  | 'star'
  | 'running'
  | 'asking'
  | 'close';

function iconBody(name: PaletteIconName): SVGTemplateResult {
  switch (name) {
    case 'search':
      return svg`<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/>`;
    case 'command':
      return svg`<path d="M4 6l5 6-5 6"/><path d="M12 18h8"/>`;
    case 'keyboard':
      return svg`<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M6.5 9.5h.01M10.5 9.5h.01M14.5 9.5h.01M17.5 9.5h.01M7.5 14.5h9"/>`;
    case 'topic':
      return svg`<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4.5 3.5z"/>`;
    case 'star':
      return svg`<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.9z"/>`;
    case 'running':
      return svg`<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5v7l6-3.5z"/>`;
    case 'asking':
      return svg`<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.3 2.1-2.3 3.4"/><circle cx="12" cy="16.8" r="0.8" fill="currentColor" stroke="none"/>`;
    case 'close':
      return svg`<path d="M6 6l12 12M18 6 6 18"/>`;
  }
}

export function renderPaletteIcon(name: PaletteIconName, extraClass?: string): SVGTemplateResult {
  const cls = `ic ic-${name}${extraClass ? ` ${extraClass}` : ''}`;
  return svg`<svg
    class=${cls}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >${iconBody(name)}</svg>`;
}

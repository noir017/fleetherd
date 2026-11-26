import { render as litRender, type RenderOptions, type RootPart } from 'lit-html';

export {
  html,
  svg,
  nothing,
  noChange,
  type TemplateResult,
  type SVGTemplateResult,
  type RenderOptions,
  type RootPart,
} from 'lit-html';

// Bind creationScope to the container's ownerDocument so lit-html does not reuse a stale
// module-cached Document across jsdom test files sharing a worker (isolate: false).
const renderImpl = (
  value: unknown,
  container: HTMLElement | DocumentFragment,
  options?: RenderOptions,
): RootPart => {
  const creationScope = options?.creationScope ?? container.ownerDocument ?? undefined;
  return litRender(value, container, creationScope ? { ...options, creationScope } : options);
};

export const render: typeof litRender = Object.assign(renderImpl, litRender);

// Escapes both element content and double-quoted attribute values without touching the DOM.
export function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

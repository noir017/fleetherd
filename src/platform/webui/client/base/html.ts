export {
  html,
  svg,
  render,
  nothing,
  noChange,
  type TemplateResult,
  type SVGTemplateResult,
  type RenderOptions,
  type RootPart,
} from 'lit-html';

// Escapes both element content and double-quoted attribute values without touching the DOM.
export function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

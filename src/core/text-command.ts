/** Leading `/name` + rest-of-text (colon admits MCP names like /mcp:server:cmd). */
const TEXT_COMMAND_RE = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/;

/** Parse a leading `/name` off message text, or null when not command-shaped. */
export function parseTextCommand(text: string): { name: string; rest: string } | null {
  const m = TEXT_COMMAND_RE.exec(text.trim());
  if (!m) return null;
  const [, name = '', rest = ''] = m;
  return { name, rest: rest.trim() };
}

/**
 * Whether text starts with `/name`: agents execute native slash commands only when the first text
 * block starts with `/`, so matching messages must stay clean without quote or hint prefixes.
 */
export function looksLikeCommand(text: string): boolean {
  return parseTextCommand(text) !== null;
}

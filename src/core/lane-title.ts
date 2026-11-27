/**
 * Shape a lane name: `[<agent>] <subject>`. Leading bracketed groups are stripped repeatedly, so
 * re-titling replaces the tag instead of stacking a second one.
 */
export function formatLaneTitle(agentId: string, raw: string): string {
  let subject = raw.replace(/\s+/g, ' ').trim();
  while (subject.startsWith('[')) {
    const close = subject.indexOf(']');
    if (close < 0) break;
    subject = subject.slice(close + 1).trimStart();
  }
  // Nothing but brackets: keep the original rather than name every such conversation identically.
  if (!subject) subject = raw.replace(/\s+/g, ' ').trim();
  return `[${agentId}] ${subject}`.trim();
}

/**
 * Strip the leading `[agent] ` lane tag and any remaining square brackets so the title is safe
 * inside `[title](?t=…)` markdown links in the web UI.
 */
export function subjectOf(title: string): string {
  return title.replace(/^\[[^\]]*\]\s*/, '').replace(/[[\]]/g, '');
}

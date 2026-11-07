import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../config/schema.js';
import { formatDuration } from '../../core/tool-renderer.js';
import { clientIcons, icon, toolGlyph, type IconName } from './icons.js';

const defaults = parseConfig({ platforms: { web: { type: 'webui', token: 'w' } }, agents: [{ id: 'cc', harness: 'claude' }], routing: { default: 'cc' } });
const client = JSON.parse(clientIcons()) as { icon: Record<string, string>; mark: Record<string, string>; reaction: Record<string, string> };

describe('web UI icons', () => {
  it('has an icon for every tool emoji the gateway uses by default', () => {
    // A default added to tools.emojiMap without an icon would show as an emoji among icons.
    const emoji = [...Object.values(defaults.tools.emojiMap), defaults.tools.defaultEmoji];
    expect(emoji.filter((e) => toolGlyph(e) === undefined)).toEqual([]);
    // And the marks a finished tool and a sub-agent's line carry (core/tool-renderer.ts).
    expect(['✓', '✗', '↳'].filter((g) => toolGlyph(g) === undefined)).toEqual([]);
    expect(formatDuration(5)).toBe('5ms'); // the shape TOOL_STATUS_RE reads the mark out of
  });

  it('has an icon for every default lifecycle reaction, and leaves another emoji alone', () => {
    const { received, done, error } = defaults.inbound.reactions;
    expect([received, done, error].filter((e) => client.reaction[e] === undefined)).toEqual([]);
    expect(toolGlyph('🦀')).toBeUndefined();
  });

  it('has an icon for every mark a menu button can lead with', () => {
    // page.ts MARK: the current choice, a ticked and an unticked toggle, a workdir root.
    expect(Object.keys(client.mark).sort()).toEqual(['⌂', '●', '☐', '☑'].sort());
  });

  it('reads the same with or without the emoji presentation selector', () => {
    expect(toolGlyph('⚙️')).toBe(toolGlyph('⚙'));
    expect(toolGlyph('✏️')).toBe(icon('pencil'));
  });

  it('draws every icon on the same 24-unit grid, in the colour of the text, hidden from screen readers', () => {
    for (const [name, svg] of Object.entries(client.icon)) {
      expect(svg).toBe(icon(name as IconName));
      expect(svg).toMatch(new RegExp(`^<svg class="ic ic-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `));
      expect(svg).toContain('aria-hidden="true"');
      expect(svg.endsWith('</svg>')).toBe(true);
    }
  });

  it('can be written into a <script> as it is: no < survives into the literal', () => {
    // A `</script>` in a string would end the page's script there.
    expect(clientIcons()).not.toContain('<');
    expect(client.icon['check']).toContain('<path');
  });
});

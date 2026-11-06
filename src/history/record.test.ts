import { describe, expect, it } from 'vitest';
import { TOOL_INPUT_KEEP, toolText } from './record.js';

describe('toolText', () => {
  it('is the line alone when the arguments say nothing more', () => {
    expect(toolText('Bash', 'git status', 'git status')).toBe('Bash: git status');
    expect(toolText('Bash', 'git status', undefined)).toBe('Bash: git status');
    expect(toolText('Bash', '', {})).toBe('Bash');
  });

  it('adds the whole arguments under the line, which stays short', () => {
    const command = `cat <<'EOF' > a.txt\n${'x'.repeat(300)}\nEOF`;
    const text = toolText('Bash', command, { command, description: 'write a file' }, 'reviewer');
    const [line, json] = text.split('\n', 2);
    expect(line).toMatch(/^reviewer · Bash: cat <<'EOF' > a\.txt x+…$/);
    expect(line!.length).toBeLessThan(230);
    expect(text.slice(line!.length + 1)).toBe(JSON.stringify({ command, description: 'write a file' }));
    expect(json!.startsWith('{"command":')).toBe(true);
  });

  it('cuts a pathological call and says how much it cut', () => {
    const content = 'y'.repeat(TOOL_INPUT_KEEP + 50);
    const text = toolText('Write', 'big.txt', { file_path: 'big.txt', content });
    const full = JSON.stringify({ file_path: 'big.txt', content });
    expect(text.endsWith(`\n[cut: ${full.length - TOOL_INPUT_KEEP} more characters]`)).toBe(true);
  });
});

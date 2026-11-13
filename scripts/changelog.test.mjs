import { describe, expect, it } from 'vitest';
import { conflictMarkers, mergeSubsections } from './changelog.mjs';

describe('conflictMarkers', () => {
  it('recognises the three lines a merge conflict leaves', () => {
    expect(conflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> branch\n')).toBe(true);
    expect(conflictMarkers('a\n=======\nb\n')).toBe(true);
  });

  it('does not fire on ordinary prose or headings', () => {
    expect(conflictMarkers('### Added\n\n- a line with ======= inside it\n')).toBe(false);
    expect(conflictMarkers('## [1.0.0] - 2026-01-01\n')).toBe(false);
  });
});

describe('mergeSubsections', () => {
  it('returns a body with no duplicates byte for byte', () => {
    const body = '### Added\n\n- one\n\n### Fixed\n\n- two\n';
    expect(mergeSubsections(body)).toBe(body);
  });

  it('folds a repeated heading into the first one, keeping order and contents', () => {
    const body = '### Added\n\n- one\n\n### Fixed\n\n- two\n\n### Added\n\n- three\n';
    expect(mergeSubsections(body)).toBe('### Added\n\n- one\n\n- three\n\n### Fixed\n\n- two\n\n');
  });

  it('keeps the file\'s own line endings', () => {
    const body = '### Added\r\n\r\n- one\r\n\r\n### Added\r\n\r\n- two\r\n';
    expect(mergeSubsections(body, '\r\n')).toBe('### Added\r\n\r\n- one\r\n\r\n- two\r\n\r\n');
  });

  it('treats ### inside a fenced code block as content, not a heading', () => {
    const body = [
      '### Added',
      '',
      '- one',
      '',
      '```md',
      '### Added',
      '- a quoted heading',
      '```',
      '',
      '### Added',
      '',
      '- two',
      '',
    ].join('\n');
    const merged = mergeSubsections(body);
    // The quoted heading stays inside its fence; the two real ones became one section.
    expect(merged).toBe(
      '### Added\n\n- one\n\n```md\n### Added\n- a quoted heading\n```\n\n- two\n\n'
    );
  });

  it('handles a tilde fence', () => {
    const body = '### Added\n\n~~~\n### Added\n~~~\n\n### Added\n\n- two\n';
    expect(mergeSubsections(body)).toBe('### Added\n\n~~~\n### Added\n~~~\n\n- two\n\n');
  });
});

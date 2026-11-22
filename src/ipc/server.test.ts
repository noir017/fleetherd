import { describe, expect, it } from 'vitest';
import { isNamedPipe } from './server.js';

describe('isNamedPipe', () => {
  it('recognizes Windows named pipe paths case-insensitively', () => {
    expect(isNamedPipe('\\\\.\\pipe\\fleetherd-0123456789abcdef')).toBe(true);
    expect(isNamedPipe('\\\\?\\PIPE\\fleetherd-test')).toBe(true);
  });

  it('rejects POSIX socket paths and regular Windows file paths', () => {
    expect(isNamedPipe('/tmp/fleetherd/daemon.sock')).toBe(false);
    expect(isNamedPipe('C:\\Users\\alice\\.config\\fleetherd\\daemon.sock')).toBe(false);
    expect(isNamedPipe('daemon.sock')).toBe(false);
  });
});

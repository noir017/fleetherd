import { describe, expect, it } from 'vitest';
import { parseRelayUrl, parseSeconds } from './api-agent.js';

describe('api-agent mailbox flags', () => {
  it('takes an https relay URL, or http to this machine for a local relay', () => {
    expect(parseRelayUrl('https://mailbox.example.com/')).toBe('https://mailbox.example.com');
    expect(parseRelayUrl(' https://example.com/relay ')).toBe('https://example.com/relay');
    expect(parseRelayUrl('http://127.0.0.1:18826')).toBe('http://127.0.0.1:18826');
    expect(() => parseRelayUrl(undefined)).toThrow(/--url or set MAILBOX_URL/);
    expect(() => parseRelayUrl('http://mailbox.example.com')).toThrow(/https/);
    expect(() => parseRelayUrl('https://user:pw@mailbox.example.com')).toThrow(/MAILBOX_TOKEN/);
    expect(() => parseRelayUrl('https://mailbox.example.com/?token=x')).toThrow(/no credentials, query/);
    expect(() => parseRelayUrl('not a url')).toThrow(/not a URL/);
  });

  it('reads timeouts in seconds', () => {
    expect(parseSeconds(undefined, 120_000, '--pickup-timeout')).toBe(120_000);
    expect(parseSeconds('7.5', 0, '--pickup-timeout')).toBe(7_500);
    expect(() => parseSeconds('0', 0, '--silence-timeout')).toThrow(/--silence-timeout takes a positive number/);
  });
});

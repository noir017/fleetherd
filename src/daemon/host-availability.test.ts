import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVAILABILITY_INTERVAL_MS, AVAILABILITY_RECHECK_MS, HostAvailability } from './host-availability.js';

/**
 * The policy alone: what counts as offline and when the page is told. The probe is a fake whose
 * answer the test sets, the clock is vitest's, and "is the connection up" is a set the test fills.
 */
function rig() {
  const answers = new Map<string, boolean>();
  const probed: string[] = [];
  const up = new Set<string>();
  let changes = 0;
  const watch = new HostAvailability({
    probe: (ssh) => {
      probed.push(ssh);
      return Promise.resolve(answers.get(ssh) ?? true);
    },
    isUp: (id) => up.has(id),
    onChange: () => {
      changes += 1;
    },
  });
  return { watch, answers, probed, up, changes: () => changes };
}

const HOSTS = { laptop: { ssh: 'user@192.0.2.99:10022' }, uniagent: { ssh: 'user@uniagent:22' } };

describe('HostAvailability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('probes every host at once, and calls none offline that answers', async () => {
    const r = rig();
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.probed.sort()).toEqual(['user@192.0.2.99:10022', 'user@uniagent:22']);
    expect(r.watch.offline().size).toBe(0);
    expect(r.changes()).toBe(0);
  });

  it('marks a host offline only after a second failure in a row, since the first', async () => {
    const r = rig();
    r.answers.set(HOSTS.laptop.ssh, false);
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(0);
    // One failure is a blink, not an outage.
    expect(r.watch.offline().size).toBe(0);

    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS);
    expect([...r.watch.offline()]).toEqual([['laptop', 1_000_000]]);
    expect(r.changes()).toBe(1);

    // Still down at the next tick: nothing new to say, and `since` stays the first failure.
    await vi.advanceTimersByTimeAsync(AVAILABILITY_INTERVAL_MS);
    expect([...r.watch.offline()]).toEqual([['laptop', 1_000_000]]);
    expect(r.changes()).toBe(1);
  });

  it('does not count a blink that answers on the recheck', async () => {
    const r = rig();
    r.answers.set(HOSTS.laptop.ssh, false);
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(0);
    r.answers.set(HOSTS.laptop.ssh, true);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS);
    expect(r.watch.offline().size).toBe(0);
    expect(r.changes()).toBe(0);
  });

  it('sees a host come back at the next tick, and says so once', async () => {
    const r = rig();
    r.answers.set(HOSTS.laptop.ssh, false);
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS);
    expect(r.watch.offline().has('laptop')).toBe(true);

    r.answers.set(HOSTS.laptop.ssh, true);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_INTERVAL_MS);
    expect(r.watch.offline().size).toBe(0);
    expect(r.changes()).toBe(2);
  });

  it('takes a connection that is up as proof, without probing', async () => {
    const r = rig();
    r.up.add('uniagent');
    r.watch.configure({ uniagent: HOSTS.uniagent });
    await vi.advanceTimersByTimeAsync(AVAILABILITY_INTERVAL_MS * 3);
    expect(r.probed).toEqual([]);
  });

  it('clears an outage the moment a connection comes up', async () => {
    const r = rig();
    r.answers.set(HOSTS.laptop.ssh, false);
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS);
    r.watch.connected('laptop');
    expect(r.watch.offline().size).toBe(0);
    expect(r.changes()).toBe(2);
  });

  it('probes at once when a connection drops, not at the next tick', async () => {
    const r = rig();
    r.watch.configure({ laptop: HOSTS.laptop });
    await vi.advanceTimersByTimeAsync(0);
    r.probed.length = 0;
    r.answers.set(HOSTS.laptop.ssh, false);

    r.watch.dropped('laptop');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.probed).toEqual([HOSTS.laptop.ssh]);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS);
    expect(r.watch.offline().has('laptop')).toBe(true);
  });

  it('forgets a host taken out of config, and an offline one stops counting', async () => {
    const r = rig();
    r.answers.set(HOSTS.laptop.ssh, false);
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS);
    expect(r.changes()).toBe(1);

    r.watch.configure({ uniagent: HOSTS.uniagent });
    expect(r.watch.offline().size).toBe(0);
    expect(r.changes()).toBe(2);
    r.probed.length = 0;
    await vi.advanceTimersByTimeAsync(AVAILABILITY_INTERVAL_MS);
    expect(r.probed).toEqual([HOSTS.uniagent.ssh]);
  });

  it('starts over for a host whose address changed', async () => {
    const r = rig();
    r.answers.set(HOSTS.laptop.ssh, false);
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS);
    expect(r.watch.offline().has('laptop')).toBe(true);

    r.watch.configure({ ...HOSTS, laptop: { ssh: 'user@192.0.2.99:22' } });
    expect(r.watch.offline().has('laptop')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.probed.at(-1)).toBe('user@192.0.2.99:22');
  });

  it('ignores an answer that arrives after the host was reconfigured away', async () => {
    let release: (ok: boolean) => void = () => {};
    let changes = 0;
    const watch = new HostAvailability({
      probe: () => new Promise<boolean>((resolve) => (release = resolve)),
      isUp: () => false,
      onChange: () => (changes += 1),
    });
    watch.configure({ laptop: HOSTS.laptop });
    await vi.advanceTimersByTimeAsync(0);
    watch.configure({});
    release(false);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_RECHECK_MS * 2);
    expect(watch.offline().size).toBe(0);
    expect(changes).toBe(0);
  });

  it('stops probing once stopped', async () => {
    const r = rig();
    r.watch.configure(HOSTS);
    await vi.advanceTimersByTimeAsync(0);
    r.watch.stop();
    r.probed.length = 0;
    await vi.advanceTimersByTimeAsync(AVAILABILITY_INTERVAL_MS * 2);
    expect(r.probed).toEqual([]);
  });
});

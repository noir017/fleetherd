/**
 * Which remote hosts the gateway can reach right now — what the web UI marks offline, and the
 * `/agent` menu with it.
 *
 * Not the connection's state. A connection to a host is opened when something needs it and closed
 * after five idle minutes (remote/connection.ts IDLE_CLOSE_MS), so "not connected" is the ordinary
 * state of a host nobody is using, not a sign that it is down. Nor does the connection notice a
 * host going away while nothing uses it — and a message sent to a host this gateway reached before
 * does not fail either: remote/host.ts whenUp holds it until a connection is back, so without this
 * the person sees their message sit there with no reason given. What answers "could it be reached
 * now" is a TCP connect to the host's ssh port (remote/reachable.ts canReach), every minute, with no
 * login: cheap enough for every host, and it tells a machine that is asleep from one that is idle.
 *
 * A connection that is up is proof enough, so its host is not probed; one that drops is probed at
 * once instead of at the next tick. One failed probe is not an outage — a laptop's Wi-Fi blinks — so
 * a failure is checked again after `recheckMs`, and only the second marks the host offline, with
 * `since` the first. A host is never offline before it has failed twice: at start every host is
 * presumed reachable until a probe says otherwise.
 *
 * IO is injected (the probe, whether a connection is up, the clock), so the policy is testable
 * without a network.
 */

export interface HostAvailabilityOptions {
  /** True when a TCP connection to `ssh` (`user@host[:port]`) opens; never rejects. */
  probe(ssh: string): Promise<boolean>;
  /** Whether the gateway's connection to this host is up right now. */
  isUp(id: string): boolean;
  /** Called after the set of offline hosts changed, never for a check that changed nothing. */
  onChange(): void;
  now?(): number;
  intervalMs?: number;
  recheckMs?: number;
}

interface Entry {
  ssh: string;
  /** Epoch ms of the first failed probe in a row; undefined while the last one succeeded. */
  failedSince?: number;
  /** Set once a second failure in a row confirmed it. */
  offlineSince?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export const AVAILABILITY_INTERVAL_MS = 60_000;
export const AVAILABILITY_RECHECK_MS = 5_000;

export class HostAvailability {
  private readonly hosts = new Map<string, Entry>();
  private stopped = false;

  constructor(private readonly opts: HostAvailabilityOptions) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * The hosts to watch, by id → their `ssh` destination. A host that is new, or whose address
   * changed, is probed at once; one that is gone is forgotten (and stops counting as offline).
   */
  configure(hosts: Readonly<Record<string, { ssh: string }>>): void {
    this.stopped = false;
    let changed = false;
    for (const [id, entry] of [...this.hosts]) {
      if (hosts[id]?.ssh === entry.ssh) continue;
      clearTimeout(entry.timer);
      this.hosts.delete(id);
      if (entry.offlineSince !== undefined) changed = true;
    }
    for (const [id, def] of Object.entries(hosts)) {
      if (this.hosts.has(id)) continue;
      this.hosts.set(id, { ssh: def.ssh });
      this.schedule(id, 0);
    }
    if (changed) this.opts.onChange();
  }

  /** The connection to `id` came up: it is reachable, whatever the last probe said. */
  connected(id: string): void {
    const e = this.hosts.get(id);
    if (!e) return;
    e.failedSince = undefined;
    this.set(e, undefined);
  }

  /** The connection to `id` dropped: find out now rather than at the next tick. */
  dropped(id: string): void {
    if (this.hosts.has(id)) this.schedule(id, 0);
  }

  /** Hosts that cannot be reached, by id → since when. */
  offline(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const [id, e] of this.hosts) if (e.offlineSince !== undefined) out.set(id, e.offlineSince);
    return out;
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.hosts.values()) clearTimeout(e.timer);
  }

  private schedule(id: string, delayMs: number): void {
    const e = this.hosts.get(id);
    if (!e || this.stopped) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => void this.check(id, e), delayMs);
    e.timer.unref?.();
  }

  private async check(id: string, e: Entry): Promise<void> {
    e.timer = undefined;
    const ok = this.opts.isUp(id) || (await this.opts.probe(e.ssh).catch(() => false));
    // Reconfigured or stopped while the probe was out: this answer is about an entry that is gone.
    if (this.stopped || this.hosts.get(id) !== e) return;
    if (ok || this.opts.isUp(id)) {
      e.failedSince = undefined;
      this.set(e, undefined);
      this.schedule(id, this.opts.intervalMs ?? AVAILABILITY_INTERVAL_MS);
    } else if (e.failedSince === undefined) {
      e.failedSince = this.now;
      this.schedule(id, this.opts.recheckMs ?? AVAILABILITY_RECHECK_MS);
    } else {
      this.set(e, e.offlineSince ?? e.failedSince);
      this.schedule(id, this.opts.intervalMs ?? AVAILABILITY_INTERVAL_MS);
    }
  }

  private set(e: Entry, offlineSince: number | undefined): void {
    if (e.offlineSince === offlineSince) return;
    e.offlineSince = offlineSince;
    this.opts.onChange();
  }
}

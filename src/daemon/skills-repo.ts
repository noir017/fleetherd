import fs from 'node:fs';
import path from 'node:path';
import { redactProxyUrl } from '../core/proxy.js';
import {
  SKILL_AUTHORS,
  commitPaths,
  dirtyPaths,
  gitAsync,
  gitAvailable,
  gitSync,
  hasHead,
  initRepo,
  isRepo,
} from './skills-git.js';
import type { Config } from '../config/schema.js';
import { defaultIdentityFile, defaultKnownHostsFile, expandLocalHome } from './remote-hosts.js';
import { ARCHIVE_DIR, SKILLS_DIR, isSkillName, repoRoot, usagePath } from './skills-store.js';

/**
 * Keeping the managed skills' repository in step with a shared one (`skills.repo` in config.yaml),
 * and moving an old store into a repository in the first place.
 *
 * ── The cycle ────────────────────────────────────────────────────────────────────────────────────
 * fetch → integrate → push. Fetch and push are the network, so they are asynchronous and time out;
 * integrate is local and synchronous (skills-git.ts says why). It runs every five minutes, and
 * around every write: before, so the version a `patch` is checked against is the repository's
 * newest and a person's commit refuses a stale edit the same way another agent's would; after, so
 * a change reaches the repository while the turn that made it is still the one waiting.
 *
 * ── When the two sides disagree ──────────────────────────────────────────────────────────────────
 * The gateway's own commits are rebased onto the repository's. Two edits of the same file — a
 * person's push landing between the gateway's fetch and its push — cannot both win; the person's
 * does. The gateway's commits are kept on a branch named `talkcode-unpushed-<time>`, pushed when it
 * can be, and the log says so. Nothing is dropped silently, and nothing is force-pushed.
 *
 * ── Unreachable ──────────────────────────────────────────────────────────────────────────────────
 * A write still commits locally and the agent gets its answer; the push is retried by the next
 * cycle. The log says when the repository stops answering and when it answers again, once each,
 * not every five minutes.
 */

export interface SkillsRemote {
  /** A git URL: `ssh://git@host:port/owner/repo.git`, or an https one. */
  url: string;
  branch: string;
  /** The ssh key and known_hosts, pinned the way a remote host's are (binaries.ts sshArgs). */
  identityFile: string;
  knownHostsFile: string;
}

/** `skills:` in config.yaml as the sync uses it, with the key paths defaulted and `~` expanded. */
export function skillsRemoteOf(config: Pick<Config, 'skills'>): SkillsRemote | undefined {
  const s = config.skills;
  if (!s) return undefined;
  return {
    url: s.repo,
    branch: s.branch,
    identityFile: expandLocalHome(s.identityFile ?? defaultIdentityFile()),
    knownHostsFile: expandLocalHome(s.knownHostsFile ?? defaultKnownHostsFile()),
  };
}

const FETCH_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 30_000;
export const SKILLS_SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * A URL fit for the log: an http(s) URL's userinfo masked — a token often rides there, as the user
 * or the password. An ssh URL's user is an account name (`git@`), not a secret, and stays.
 */
export function redactRepoUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? redactProxyUrl(url) : url;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ssh git runs: no ssh config of the machine's, the gateway's own key and known_hosts, and a
 * host key that is not already in that file fails the connection rather than being learned — the
 * same pinning as a remote host's (AGENTS.md invariant 5).
 */
export function gitSshCommand(remote: SkillsRemote): string {
  return [
    'ssh',
    '-F', 'none',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', quote(`IdentityFile=${remote.identityFile}`),
    '-o', quote(`UserKnownHostsFile=${remote.knownHostsFile}`),
    '-o', 'StrictHostKeyChecking=yes',
    '-o', quote('HostKeyAlgorithms=-*-cert-v01@openssh.com'),
    '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR',
  ].join(' ');
}

function networkEnv(remote: SkillsRemote): NodeJS.ProcessEnv {
  return { GIT_SSH_COMMAND: gitSshCommand(remote) };
}

/**
 * Turn the store directory into a repository if it is not one yet. Synchronous and local: the
 * first fetch is the cycle's job, so a gateway that starts with the repository out of reach still
 * has every skill it had.
 *
 * An old store (`<name>/`, `.archive/`, `.usage.json`) is copied into a new repository as one
 * commit, then set aside as `skills.pre-git` — copied, so the backup stays whole whatever happens
 * to the new one. When the shared repository is fetched later, that commit is rebased on top of
 * it like any other change of the gateway's.
 */
export function prepareSkillsRepo(dir: string, log: (message: string) => void = console.log): boolean {
  const root = repoRoot(dir);
  if (isRepo(root)) return true;
  if (!gitAvailable()) {
    log('[skills] git is not installed: the managed skills are not delivered and cannot be written until it is');
    return false;
  }
  const tmp = path.join(dir, `.skills-repo-new-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  initRepo(tmp);
  const imported: string[] = [];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSkillName(entry.name)) continue;
      fs.cpSync(path.join(root, entry.name), path.join(tmp, SKILLS_DIR, entry.name), { recursive: true });
      imported.push(entry.name);
    }
    const oldArchive = path.join(root, '.archive');
    if (fs.existsSync(oldArchive)) {
      for (const entry of fs.readdirSync(oldArchive, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isSkillName(entry.name)) continue;
        fs.cpSync(path.join(oldArchive, entry.name), path.join(tmp, ARCHIVE_DIR, entry.name), { recursive: true });
        imported.push(entry.name);
      }
    }
    const oldUsage = path.join(root, '.usage.json');
    if (fs.existsSync(oldUsage) && !fs.existsSync(usagePath(dir))) fs.copyFileSync(oldUsage, usagePath(dir));
    if (imported.length > 0) {
      commitPaths(tmp, [SKILLS_DIR, ARCHIVE_DIR], {
        action: 'import',
        skill: imported.sort().join(', '),
        note: 'the skills the gateway kept before its store was a repository',
        by: { kind: 'gateway' },
        at: Date.now(),
      });
    }
    let backup = `${root}.pre-git`;
    if (fs.existsSync(backup)) backup = `${backup}-${Date.now()}`;
    fs.renameSync(root, backup);
    log(`[skills] the skills store is a git repository now; the old one is kept at ${backup}`);
  }
  fs.renameSync(tmp, root);
  return true;
}

type Phase = 'ok' | 'failing';

export interface SkillsRepoOptions {
  dir: string;
  /** Read on every cycle, so a `/reload` that adds, changes or removes `skills.repo` takes effect. */
  remote: () => SkillsRemote | undefined;
  log?: (message: string) => void;
  now?: () => number;
}

export class SkillsRepo {
  private chain: Promise<unknown> = Promise.resolve();
  private phase: Phase = 'ok';
  private readonly log: (message: string) => void;

  constructor(private readonly opts: SkillsRepoOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** One fetch → integrate → push. Errors are logged, never thrown: the next cycle tries again. */
  sync(): Promise<void> {
    return this.exclusive(async () => {
      const remote = this.ready();
      if (!remote) return;
      try {
        await this.pull(remote);
        await this.push(remote);
        this.recovered(remote);
      } catch (e) {
        this.failed(remote, e);
      }
    });
  }

  /**
   * Run one synchronous store write between a pull and a push. The write's own error (a refused
   * version, a bad name) is the caller's answer and propagates; the network's is logged and the
   * write still happens, locally, to be pushed by a later cycle.
   */
  write<T>(fn: () => T): Promise<T> {
    return this.exclusive(async () => {
      const remote = this.ready();
      if (remote) {
        try {
          await this.pull(remote);
        } catch (e) {
          this.failed(remote, e);
        }
      }
      const result = fn();
      if (remote) {
        try {
          await this.push(remote);
          this.recovered(remote);
        } catch (e) {
          this.failed(remote, e);
        }
      }
      return result;
    });
  }

  /** Sync now and then every `intervalMs`. Returns the stop function; the timer never holds the process. */
  start(intervalMs = SKILLS_SYNC_INTERVAL_MS): () => void {
    void this.sync();
    const timer = setInterval(() => void this.sync(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The remote to talk to, with `origin` pointed at it; undefined when there is none, or no repository. */
  private ready(): SkillsRemote | undefined {
    const remote = this.opts.remote();
    const root = repoRoot(this.opts.dir);
    if (!remote || !isRepo(root)) return undefined;
    let current: string | undefined;
    try {
      current = gitSync(root, ['remote', 'get-url', 'origin']).trim();
    } catch {
      current = undefined;
    }
    if (current === undefined) gitSync(root, ['remote', 'add', 'origin', remote.url]);
    else if (current !== remote.url) gitSync(root, ['remote', 'set-url', 'origin', remote.url]);
    return remote;
  }

  private async pull(remote: SkillsRemote): Promise<void> {
    const root = repoRoot(this.opts.dir);
    await gitAsync(
      root,
      ['fetch', '-q', '--prune', 'origin', `+refs/heads/${remote.branch}:${remoteRef(remote)}`],
      networkEnv(remote),
      FETCH_TIMEOUT_MS
    );
    this.integrate(remote);
  }

  /**
   * Bring the local branch onto the fetched one. Synchronous: see the module comment. Anything
   * uncommitted under the skill directories (a write cut off before its commit, a hand edit in the
   * gateway's copy) is committed first, so a rebase never has to choose what to do with it.
   */
  private integrate(remote: SkillsRemote): void {
    const root = repoRoot(this.opts.dir);
    const ref = remoteRef(remote);
    if (!refExists(root, ref)) return;
    this.commitStray(root);
    if (!hasHead(root)) {
      gitSync(root, ['checkout', '-q', '-B', 'main', ref]);
      return;
    }
    const behind = count(root, `HEAD..${ref}`);
    if (behind === 0) return;
    const ahead = count(root, `${ref}..HEAD`);
    if (ahead === 0) {
      gitSync(root, ['merge', '-q', '--ff-only', ref]);
      return;
    }
    try {
      // A rebase writes new commits, and git config is switched off (skills-git.ts), so the
      // committer has to be named here; each commit keeps its own author.
      const gateway = SKILL_AUTHORS.gateway;
      gitSync(root, ['rebase', '-q', ref], { GIT_COMMITTER_NAME: gateway.name, GIT_COMMITTER_EMAIL: gateway.email });
    } catch (e) {
      try {
        gitSync(root, ['rebase', '--abort']);
      } catch {
        // nothing in progress to abort: the rebase refused before it started
      }
      const branch = `talkcode-unpushed-${new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`;
      gitSync(root, ['branch', '-f', branch, 'HEAD']);
      gitSync(root, ['reset', '-q', '--hard', ref]);
      this.log(
        `[skills] ${ahead} change(s) of the gateway's could not go on top of ${redactRepoUrl(remote.url)} (${firstLine(e)}); ` +
          `the repository's version wins, and the gateway's is kept on branch ${branch}`
      );
      void gitAsync(root, ['push', '-q', 'origin', `${branch}:refs/heads/${branch}`], networkEnv(remote), PUSH_TIMEOUT_MS).catch(
        (err: unknown) => this.log(`[skills] could not push ${branch}: ${firstLine(err)}`)
      );
    }
  }

  private commitStray(root: string): void {
    const dirty = dirtyPaths(root, [SKILLS_DIR, ARCHIVE_DIR]);
    if (dirty.length === 0) return;
    commitPaths(root, [SKILLS_DIR, ARCHIVE_DIR], {
      action: 'commit-stray',
      skill: dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ', …' : ''),
      note: 'changes found uncommitted in the gateway\'s copy',
      by: { kind: 'gateway' },
      at: this.now(),
    });
    this.log(`[skills] committed ${dirty.length} uncommitted change(s) found in the gateway's copy`);
  }

  /** Push what is ahead. Rejected because the repository moved: pull once more and push again. */
  private async push(remote: SkillsRemote): Promise<void> {
    const root = repoRoot(this.opts.dir);
    if (!hasHead(root)) return;
    const ref = remoteRef(remote);
    if (refExists(root, ref) && count(root, `${ref}..HEAD`) === 0) return;
    const args = ['push', '-q', 'origin', `HEAD:refs/heads/${remote.branch}`];
    try {
      await gitAsync(root, args, networkEnv(remote), PUSH_TIMEOUT_MS);
    } catch (e) {
      if (!/rejected|non-fast-forward|fetch first/i.test(String(e))) throw e;
      await this.pull(remote);
      if (refExists(root, ref) && count(root, `${ref}..HEAD`) === 0) return;
      await gitAsync(root, args, networkEnv(remote), PUSH_TIMEOUT_MS);
    }
    await gitAsync(
      root,
      ['fetch', '-q', 'origin', `+refs/heads/${remote.branch}:${ref}`],
      networkEnv(remote),
      FETCH_TIMEOUT_MS
    ).catch(() => undefined);
  }

  private failed(remote: SkillsRemote, e: unknown): void {
    if (this.phase === 'failing') return;
    this.phase = 'failing';
    this.log(`[skills] ${redactRepoUrl(remote.url)} is not reachable (${firstLine(e)}); writes stay local until it is`);
  }

  private recovered(remote: SkillsRemote): void {
    if (this.phase === 'ok') return;
    this.phase = 'ok';
    this.log(`[skills] ${redactRepoUrl(remote.url)} answers again`);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

function remoteRef(remote: SkillsRemote): string {
  return `refs/remotes/origin/${remote.branch}`;
}

function refExists(root: string, ref: string): boolean {
  try {
    gitSync(root, ['rev-parse', '--verify', '-q', ref]);
    return true;
  } catch {
    return false;
  }
}

function count(root: string, range: string): number {
  return Number(gitSync(root, ['rev-list', '--count', range]).trim()) || 0;
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
}

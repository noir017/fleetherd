import fs from 'node:fs';
import path from 'node:path';

/**
 * A directory of the gateway's own kept equal to a map of files — a managed skill's copy
 * (managed-skills.ts) and the bundled skill's rendered copy (bundled-skill.ts). Only what differs
 * is written, so an unchanged copy costs reads and no write.
 */

export interface CopyResult {
  outcome: 'placed' | 'current' | 'failed';
  detail?: string;
}

/** Keep `copy` exactly equal to `files` (relative `/` paths): write what changed, remove the rest. */
export function syncSkillCopy(copy: string, files: ReadonlyMap<string, Buffer>): CopyResult {
  try {
    let changed = false;
    try {
      if (fs.lstatSync(copy).isSymbolicLink()) fs.rmSync(copy, { force: true });
    } catch {
      // not there yet
    }
    for (const [rel, data] of files) {
      const dest = path.join(copy, ...rel.split('/'));
      try {
        if (fs.readFileSync(dest).equals(data)) continue;
      } catch {
        // missing, or a directory where a file belongs: write it
      }
      writeAtomic(dest, data, rel.startsWith('scripts/') ? 0o555 : 0o444);
      changed = true;
    }
    for (const rel of listTree(copy)) {
      if (files.has(rel)) continue;
      fs.rmSync(path.join(copy, ...rel.split('/')), { force: true });
      changed = true;
    }
    return { outcome: changed ? 'placed' : 'current' };
  } catch (e) {
    return { outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Every file under `dir`, as relative `/` paths; none for a directory that does not exist. */
export function listTree(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listTree(dir, rel));
    else out.push(rel);
  }
  return out;
}

function writeAtomic(file: string, data: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

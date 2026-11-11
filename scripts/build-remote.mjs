// Build fleetherd-remote (remote/, Go) for every architecture a gateway may meet on a host, into
// dist/remote-bin/ — part of `npm run build`, so the release tarball always carries both.
//
// Static (CGO_ENABLED=0) and stripped: a host needs nothing but the binary, which is the point of
// writing this half in Go. -trimpath keeps this machine's paths out of it, and the build is
// reproducible enough that the same source gives the same hash — which matters, because the hash
// is part of the directory name a host installs it under (src/remote/binaries.ts).
//
//   node scripts/build-remote.mjs              both architectures
//   node scripts/build-remote.mjs --native     only this machine's (a quick dev loop)
//   node scripts/build-remote.mjs --check      go vet + go test, no build (the release gate)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'remote');
const out = path.join(root, 'dist', 'remote-bin');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const go = (args, env = {}) =>
  execFileSync('go', args, { cwd: src, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', ...env } });

try {
  execFileSync('go', ['version'], { stdio: 'ignore' });
} catch {
  console.error('build-remote: the Go toolchain is required (https://go.dev/dl/) to build fleetherd-remote');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  go(['vet', './...']);
  go(['test', '-count=1', './...']);
  process.exit(0);
}

const native = process.arch === 'arm64' ? 'arm64' : 'amd64';
const arches = process.argv.includes('--native') ? [native] : ['amd64', 'arm64'];
fs.mkdirSync(out, { recursive: true });
for (const arch of arches) {
  const target = path.join(out, `fleetherd-remote-linux-${arch}`);
  go(['build', '-trimpath', '-ldflags', `-s -w -X main.buildVersion=${version}`, '-o', target, '.'], {
    GOOS: 'linux',
    GOARCH: arch,
  });
  console.log(`build-remote: ${path.relative(root, target)} (${(fs.statSync(target).size / 1048576).toFixed(1)} MiB)`);
}

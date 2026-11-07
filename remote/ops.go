package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// One-shot operations (`rpc` frames): the filesystem and command access the gateway used to have
// for free when its agents ran on its own disk — reading the tail of a Claude Code transcript,
// placing an inbound attachment, listing a workspace for `/cd`, linking the bundled skill, running a
// preLaunch hook. Each answers with `rpc-ok` (a JSON `res`, plus a body for file contents and
// command output) or `rpc-err`.

const (
	defaultReadMax = 8 << 20
	// A frame body is capped at maxBodyBytes; the gateway reads bigger files in chunks (`offset`).
	readChunkCap  = maxBodyBytes - (64 << 10)
	defaultRunMax = 1 << 20
	runMaxCap     = 8 << 20
)

func (d *daemon) handleRPC(gen uint64, h *Header, body []byte) {
	ctx, cancel := context.WithCancel(context.Background())
	d.mu.Lock()
	d.rpcs[h.Rid] = cancel
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.rpcs, h.Rid)
		d.mu.Unlock()
		cancel()
	}()

	res, out, err := d.op(ctx, h, body)
	if err != nil {
		d.link.send(gen, &Header{T: "rpc-err", Rid: h.Rid, Error: err.Error()}, nil, false)
		return
	}
	raw, err := json.Marshal(res)
	if err != nil {
		d.link.send(gen, &Header{T: "rpc-err", Rid: h.Rid, Error: err.Error()}, nil, false)
		return
	}
	d.link.send(gen, &Header{T: "rpc-ok", Rid: h.Rid, Res: raw}, out, false)
}

func (d *daemon) op(ctx context.Context, h *Header, body []byte) (any, []byte, error) {
	path := expandHome(h.Path)
	switch h.Op {
	case "stat":
		return opStat(path)
	case "listDir":
		return opListDir(path)
	case "mkdirp":
		mode := fs.FileMode(0o755)
		if h.Mode != 0 {
			mode = fs.FileMode(h.Mode)
		}
		return map[string]any{}, nil, os.MkdirAll(path, mode)
	case "readFile":
		return opReadFile(path, h.Max, h.Offset)
	case "readTail":
		return opReadTail(path, h.Max, h.Grep, h.Fields)
	case "writeFile":
		if h.Atomic {
			return opWriteFileAtomic(path, body, h.Mode, h.Append)
		}
		return opWriteFile(path, body, h.Mode, h.Append)
	case "ensureLink":
		return opEnsureLink(expandHome(h.Target), path, expandHome(h.Requires), expandHome(h.Owned))
	case "removeLink":
		return opRemoveLink(path, expandHome(h.Owned))
	case "removePath":
		return opRemovePath(path, expandHome(h.Owned))
	case "listFiles":
		return opListFiles(path)
	case "sweepSkillLinks":
		return opSweepSkillLinks(path)
	case "run":
		return d.opRun(ctx, h, body)
	case "relay":
		return d.opRelay(h)
	}
	return nil, nil, fmt.Errorf("unknown operation %q", h.Op)
}

func opStat(path string) (any, []byte, error) {
	st, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]any{"exists": false}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return map[string]any{
		"exists": true, "dir": st.IsDir(), "size": st.Size(), "mtimeMs": st.ModTime().UnixMilli(),
	}, nil, nil
}

// opListDir lists a directory with each entry's type AFTER following symlinks — what the gateway's
// `/cd` scan asks of stat (workdir-scan.ts): a workspace of links into mounted volumes is normal.
func opListDir(path string) (any, []byte, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, nil, err
	}
	type entry struct {
		Name string `json:"name"`
		Dir  bool   `json:"dir"`
	}
	out := make([]entry, 0, len(entries))
	for _, e := range entries {
		st, err := os.Stat(filepath.Join(path, e.Name()))
		if err != nil {
			continue // a broken link, or gone since the listing
		}
		out = append(out, entry{Name: e.Name(), Dir: st.IsDir()})
	}
	return map[string]any{"entries": out}, nil, nil
}

// opReadFile reads up to `max` bytes from `offset`, so a file larger than one frame
// comes over in pieces. `size` lets the caller know when it has all of it.
func opReadFile(path string, max int64, offset uint64) (any, []byte, error) {
	if max <= 0 {
		max = defaultReadMax
	}
	if max > readChunkCap {
		max = readChunkCap
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if st.IsDir() {
		return nil, nil, fmt.Errorf("%s is a directory", path)
	}
	size := st.Size()
	if int64(offset) >= size {
		return map[string]any{"size": size}, nil, nil
	}
	n := size - int64(offset)
	if n > max {
		n = max
	}
	buf := make([]byte, n)
	read, err := f.ReadAt(buf, int64(offset))
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, err
	}
	return map[string]any{"size": size}, buf[:read], nil
}

// opReadTail returns the last `max` bytes as whole lines (the first is dropped when the window cut
// it), optionally only those containing one of `grep`, and optionally with each JSON line cut down
// to `fields` (dotted paths; a line that is not a JSON object is dropped). The projection is what
// keeps the Claude Code cache reading cheap: the gateway needs each entry's type, timestamp and
// usage from a window that is a megabyte of tool output, so only those few fields cross the network.
func opReadTail(path string, max int64, grep, fields []string) (any, []byte, error) {
	if max <= 0 {
		max = defaultReadMax
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	start := st.Size() - max
	if start < 0 {
		start = 0
	}
	buf := make([]byte, st.Size()-start)
	if _, err := f.ReadAt(buf, start); err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, err
	}
	lines := bytes.Split(buf, []byte{'\n'})
	if start > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	if len(grep) > 0 {
		kept := lines[:0]
		for _, ln := range lines {
			for _, g := range grep {
				if bytes.Contains(ln, []byte(g)) {
					kept = append(kept, ln)
					break
				}
			}
		}
		lines = kept
	}
	if len(fields) > 0 {
		kept := lines[:0]
		for _, ln := range lines {
			if p := projectJSON(ln, fields); p != nil {
				kept = append(kept, p)
			}
		}
		lines = kept
	}
	out := bytes.Join(lines, []byte{'\n'})
	if len(out) > readChunkCap {
		out = out[len(out)-readChunkCap:]
	}
	return map[string]any{"size": st.Size(), "truncated": start > 0}, out, nil
}

// projectJSON keeps only `fields` (dotted paths) of one JSON object line; nil for anything else.
func projectJSON(line []byte, fields []string) []byte {
	var m map[string]any
	if json.Unmarshal(line, &m) != nil {
		return nil
	}
	out := map[string]any{}
	for _, f := range fields {
		copyPath(m, out, strings.Split(f, "."))
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return b
}

func copyPath(src, dst map[string]any, parts []string) {
	v, ok := src[parts[0]]
	if !ok {
		return
	}
	if len(parts) == 1 {
		dst[parts[0]] = v
		return
	}
	sub, ok := v.(map[string]any)
	if !ok {
		return
	}
	next, _ := dst[parts[0]].(map[string]any)
	if next == nil {
		next = map[string]any{}
	}
	copyPath(sub, next, parts[1:])
	if len(next) > 0 { // no empty objects for paths that were not there
		dst[parts[0]] = next
	}
}

// opWriteFile writes (or with `appendMode`, appends) one piece of a file, creating its directory
// owner-only. Inbound attachments are the user's files: nobody else on the host needs to read them.
func opWriteFile(path string, body []byte, mode uint32, appendMode bool) (any, []byte, error) {
	perm := fs.FileMode(0o600)
	if mode != 0 {
		perm = fs.FileMode(mode)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, err
	}
	flags := os.O_CREATE | os.O_WRONLY
	if appendMode {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, perm)
	if err != nil {
		return nil, nil, err
	}
	if _, err := f.Write(body); err != nil {
		f.Close()
		return nil, nil, err
	}
	if err := f.Close(); err != nil {
		return nil, nil, err
	}
	return map[string]any{"path": path}, nil, nil
}

// opWriteFileAtomic replaces `path` with `body` in one step: written beside it under a temporary
// name, then renamed over it. For a file an agent may be reading at the moment it changes — the
// operator's instructions (daemon/instructions.ts), which a harness reads at startup — where
// opWriteFile's truncate-then-write would let a reader see an empty or half-written file. The
// rename also replaces a read-only file, which is what lets that one be kept read-only on the host.
// One frame only: a chunked append cannot be made atomic this way, so it is refused.
func opWriteFileAtomic(path string, body []byte, mode uint32, appendMode bool) (any, []byte, error) {
	if appendMode {
		return nil, nil, errors.New("an atomic write cannot append")
	}
	perm := fs.FileMode(0o600)
	if mode != 0 {
		perm = fs.FileMode(mode)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return nil, nil, err
	}
	tmp := f.Name()
	fail := func(err error) (any, []byte, error) {
		f.Close()
		os.Remove(tmp)
		return nil, nil, err
	}
	if _, err := f.Write(body); err != nil {
		return fail(err)
	}
	if err := f.Chmod(perm); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return nil, nil, err
	}
	return map[string]any{"path": path}, nil, nil
}

// under reports whether a symlink's destination lies inside `dir`. A relative destination is read
// against the link's own directory, as the kernel reads it.
func under(link, dest, dir string) bool {
	if !filepath.IsAbs(dest) {
		dest = filepath.Join(filepath.Dir(link), dest)
	}
	return strings.HasPrefix(filepath.Clean(dest), filepath.Clean(dir)+string(os.PathSeparator))
}

// opEnsureLink makes `link` a symlink to `target`, with the same rules as the gateway's local
// skill-link.ts — only where `requires` exists (the harness has been run here), never over a real
// file or directory (that is the operator's own copy), repointing a link that points elsewhere.
//
// With `owned`, a link is repointed only when it points inside that directory. The skill links have
// names nobody else uses (`talkcode`, `super`); an instructions link sits at a harness's own global
// file (`~/.codex/AGENTS.md`), where a symlink is just as likely the operator's way of keeping their
// own file somewhere else — that one is theirs, and is reported as occupied like a real file.
func opEnsureLink(target, link, requires, owned string) (any, []byte, error) {
	result := func(outcome, detail string) (any, []byte, error) {
		return map[string]any{"outcome": outcome, "detail": detail, "link": link}, nil, nil
	}
	if requires != "" {
		if _, err := os.Stat(requires); err != nil {
			return result("skipped", requires+" does not exist")
		}
	}
	previous := ""
	if st, err := os.Lstat(link); err == nil {
		if st.Mode()&fs.ModeSymlink == 0 {
			if st.IsDir() {
				return result("occupied", "a directory")
			}
			return result("occupied", "a file")
		}
		previous, _ = os.Readlink(link)
		if previous == target {
			return result("current", "")
		}
		if owned != "" && !under(link, previous, owned) {
			return result("occupied", "a link to "+previous)
		}
		if err := os.Remove(link); err != nil {
			return result("failed", err.Error())
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return result("failed", err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		return result("failed", err.Error())
	}
	if err := os.Symlink(target, link); err != nil {
		return result("failed", err.Error())
	}
	if previous != "" {
		return result("relinked", previous)
	}
	return result("linked", "")
}

// opRemoveLink takes back a link the gateway made: `link` is removed only if it is a symlink
// pointing inside `owned`. Anything else at that path — a real file, the operator's own link, or
// nothing — is left as it is and said so (`kept` / `absent`). An empty `owned` is refused rather
// than read as "anywhere": this deletes from directories the operator owns.
func opRemoveLink(link, owned string) (any, []byte, error) {
	result := func(outcome, detail string) (any, []byte, error) {
		return map[string]any{"outcome": outcome, "detail": detail, "link": link}, nil, nil
	}
	if owned == "" {
		return nil, nil, errors.New("removeLink needs the directory its links point into")
	}
	st, err := os.Lstat(link)
	if errors.Is(err, fs.ErrNotExist) {
		return result("absent", "")
	}
	if err != nil {
		return result("failed", err.Error())
	}
	if st.Mode()&fs.ModeSymlink == 0 {
		return result("kept", "not a link")
	}
	dest, err := os.Readlink(link)
	if err != nil {
		return result("failed", err.Error())
	}
	if !under(link, dest, owned) {
		return result("kept", "a link to "+dest)
	}
	if err := os.Remove(link); err != nil {
		return result("failed", err.Error())
	}
	return result("removed", dest)
}

// opRemovePath deletes one file or directory tree the gateway put on the host — a managed skill's
// copy, or a file that version no longer carries. It is the remote counterpart of the local
// delivery's prune, and it has the same limit: `path` must be strictly inside `owned`, and `owned`
// is the skill's own copy directory (or the skills root when the copy itself goes). An empty
// `owned` is refused rather than read as "anywhere": this deletes from the operator's home.
//
// The parent is resolved through symlinks before deleting, so a link planted inside the copy cannot
// turn `removePath` into a delete outside it. The path itself is not resolved: removing a symlink
// removes the link, never its target, which is what os.RemoveAll already does.
func opRemovePath(path, owned string) (any, []byte, error) {
	if owned == "" {
		return nil, nil, errors.New("removePath needs the directory the path must stay inside")
	}
	if !under(path, path, owned) {
		return nil, nil, fmt.Errorf("refusing to remove %s: not under %s", path, owned)
	}
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return map[string]any{"removed": false, "path": path}, nil, nil
	} else if err != nil {
		return nil, nil, err
	}
	rootStat, err := os.Lstat(owned)
	if err != nil {
		return nil, nil, err
	}
	if rootStat.Mode()&fs.ModeSymlink != 0 {
		return nil, nil, fmt.Errorf("refusing to remove %s: %s is a symlink", path, owned)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return nil, nil, err
	}
	root, err := filepath.EvalSymlinks(owned)
	if err != nil {
		return nil, nil, err
	}
	if parent != filepath.Clean(root) && !strings.HasPrefix(parent, filepath.Clean(root)+string(os.PathSeparator)) {
		return nil, nil, fmt.Errorf("refusing to remove %s: %s is outside %s", path, parent, owned)
	}
	if err := os.RemoveAll(path); err != nil {
		return nil, nil, err
	}
	return map[string]any{"removed": true, "path": path}, nil, nil
}

// opListFiles lists every file under `path`, relative and slash-separated, without following
// symlinks. The gateway uses it to prune a managed skill's copy after a version change: the files
// it no longer carries are the difference between this list and the version's own file set.
func opListFiles(path string) (any, []byte, error) {
	files := []string{}
	err := filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if p == path || d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(path, p)
		if err != nil {
			return err
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return map[string]any{"files": files}, nil, nil
}

// opSweepSkillLinks removes dangling skill links in `dir` that point into this host's version
// directory (~/.talkcode/remote/<version>/…). An upgrade deletes the old version directory, and a
// link into it is only repointed by a spawn of the harness it was made for — so one made for a
// harness the gateway has since stopped mapping keeps pointing at a path that is gone, and every
// agent of that harness runs without the skill. Nothing else is touched: a real directory, a file,
// or a link pointing anywhere outside ~/.talkcode/remote belongs to the operator.
func opSweepSkillLinks(dir string) (any, []byte, error) {
	empty := map[string]any{"removed": []string{}}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return empty, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	root := rootDir()
	removed := []string{}
	for _, e := range entries {
		if e.Type()&fs.ModeSymlink == 0 {
			continue
		}
		link := filepath.Join(dir, e.Name())
		target, err := os.Readlink(link)
		if err != nil {
			continue
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(dir, target)
		}
		if !strings.HasPrefix(target, root+string(os.PathSeparator)) {
			continue
		}
		if _, err := os.Stat(target); err == nil {
			continue // still there: a link into the version the gateway is running
		}
		if err := os.Remove(link); err == nil {
			removed = append(removed, link)
		}
	}
	return map[string]any{"removed": removed}, nil, nil
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────

type runResult struct {
	Code       *int   `json:"code"`
	Signal     string `json:"signal,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	Cancelled  bool   `json:"cancelled,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	SpawnError string `json:"spawnError,omitempty"`
	Stderr     string `json:"stderr,omitempty"`
}

// opRun runs a command to completion: `argv` directly, or `bash` as `bash -lc` — the gateway's own
// runner for preLaunch hooks, scheduled `--bash` tasks (schedule-bash.ts) and the automatic
// review's `agy -p`. Its own process group, killed whole (SIGTERM, then SIGKILL) on timeout or on
// an `rpc-cancel`. Output beyond `max` keeps its END, which is where a failing script says why.
// A non-empty request body is written to the child's stdin and then closed; an empty one leaves
// stdin at /dev/null. The review needs that: its prompt is a long NDJSON line, and one argv entry
// is capped at 128 KB (MAX_ARG_STRLEN).
func (d *daemon) opRun(ctx context.Context, h *Header, stdin []byte) (any, []byte, error) {
	argv := h.Argv
	if h.Bash != "" {
		argv = []string{"bash", "-lc", h.Bash}
	}
	if len(argv) == 0 {
		return nil, nil, errors.New("run: no command")
	}
	max := h.Max
	if max <= 0 {
		max = defaultRunMax
	}
	if max > runMaxCap {
		max = runMaxCap
	}
	env := d.agentEnv(h.Env, h.Unset)
	cwd := expandHome(h.Cwd)
	if cwd == "" {
		cwd = homeDir()
	}
	path, err := lookPathIn(argv[0], envGet(env, "PATH"), cwd)
	if err != nil {
		return runResult{SpawnError: err.Error()}, nil, nil
	}
	cmd := &exec.Cmd{Path: path, Args: argv, Env: env, Dir: cwd, SysProcAttr: groupAttr()}
	// The request's body, when there is one, is the child's stdin — how a one-shot `agy -p` gets a
	// prompt too long for a single argv entry (Linux caps one at 128 KB). An empty body leaves
	// stdin at /dev/null, which is what every other run wants.
	if len(stdin) > 0 {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	// Bounded wait for output after exit: a script that left `ssh -fN` or `foo &` running would
	// otherwise hold its pipes, and this answer, forever.
	cmd.WaitDelay = time.Second
	stdout := &ring{max: int(max)}
	stderr := &ring{max: 64 << 10}
	cmd.Stdout = stdout
	if h.Merge {
		cmd.Stderr = stdout
	} else {
		cmd.Stderr = stderr
	}
	if err := startLocked(cmd); err != nil {
		return runResult{SpawnError: err.Error()}, nil, nil
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var timeout <-chan time.Time
	if h.TimeoutMs > 0 {
		t := time.NewTimer(time.Duration(h.TimeoutMs) * time.Millisecond)
		defer t.Stop()
		timeout = t.C
	}
	res := runResult{}
	select {
	case err = <-done:
	case <-timeout:
		res.TimedOut = true
		err = killGroupAndWait(cmd, done)
	case <-ctx.Done():
		res.Cancelled = true
		err = killGroupAndWait(cmd, done)
	}
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		res.Signal = signalName(ws.Signal())
	} else if cmd.ProcessState != nil {
		res.Code = intPtr(cmd.ProcessState.ExitCode())
	}
	_ = err // the exit status above says everything Wait's error would
	res.Truncated = stdout.cut
	if !h.Merge {
		res.Stderr = strings.TrimSpace(string(stderr.bytes()))
	}
	return res, stdout.bytes(), nil
}

func killGroupAndWait(cmd *exec.Cmd, done <-chan error) error {
	pgid := cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case err := <-done:
		return err
	case <-time.After(killGrace):
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return <-done
	}
}

// ring keeps the last `max` bytes written to it.
type ring struct {
	mu  sync.Mutex
	max int
	buf []byte
	cut bool
}

func (r *ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if over := len(r.buf) - r.max; over > 0 {
		r.buf = append([]byte(nil), r.buf[over:]...)
		r.cut = true
	}
	return len(p), nil
}

func (r *ring) bytes() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]byte(nil), r.buf...)
}

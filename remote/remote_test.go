package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestMain lets the test binary stand in for talkcode-remote: attach and the env capture re-run
// "this binary" with a subcommand, and under `go test` this binary is the test binary.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		main()
		return
	}
	if os.Getenv("TCR_TEST_LOG") == "" {
		log.SetOutput(io.Discard) // the daemons under test log every connection; TCR_TEST_LOG=1 shows it
	}
	os.Exit(m.Run())
}

// ── frame ─────────────────────────────────────────────────────────────────────────────────────

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, &Header{T: "out", S: 7, A: 3, ID: "p1", Fd: 2, Code: intPtr(0)}, []byte("héllo\x00")); err != nil {
		t.Fatal(err)
	}
	if err := writeFrame(&buf, &Header{T: "ping", N: 9}, nil); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(&buf)
	h, body, err := readFrame(r)
	if err != nil || h.T != "out" || h.S != 7 || h.A != 3 || h.ID != "p1" || h.Fd != 2 || h.Code == nil || *h.Code != 0 || string(body) != "héllo\x00" {
		t.Fatalf("first frame: %+v %q %v", h, body, err)
	}
	h, body, err = readFrame(r)
	if err != nil || h.T != "ping" || h.N != 9 || body != nil {
		t.Fatalf("second frame: %+v %q %v", h, body, err)
	}
	if _, _, err := readFrame(r); err == nil {
		t.Fatal("expected EOF")
	}
}

func TestFrameRejectsGarbage(t *testing.T) {
	r := bufio.NewReader(bytes.NewReader([]byte{0, 0, 0, 0, 0, 0, 0, 0}))
	if _, _, err := readFrame(r); err == nil {
		t.Fatal("a zero-length header must be rejected")
	}
	r = bufio.NewReader(bytes.NewReader([]byte{0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0}))
	if _, _, err := readFrame(r); err == nil {
		t.Fatal("an oversized header must be rejected")
	}
}

// ── link ──────────────────────────────────────────────────────────────────────────────────────

type sink struct{ frames chan []byte }

func (s *sink) Write(p []byte) (int, error) {
	s.frames <- append([]byte(nil), p...)
	return len(p), nil
}

func decode(t *testing.T, b []byte) *Header {
	t.Helper()
	h, _, err := readFrame(bufio.NewReader(bytes.NewReader(b)))
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestLinkResendsOnlyWhatThePeerMissed(t *testing.T) {
	l := newLink()
	l.reset("E")
	gen := l.currentGen()
	for i := 0; i < 3; i++ {
		l.send(gen, &Header{T: "out"}, []byte{byte('a' + i)}, false)
	}
	s := &sink{frames: make(chan []byte, 16)}
	w := newConnWriter(s, nil)
	if err := l.attach(w, 1, &Header{T: "welcome"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"welcome", "out#2", "out#3"}
	for _, wnt := range want {
		h := decode(t, <-s.frames)
		got := h.T
		if h.S > 0 {
			got += "#" + itoa(h.S)
		}
		if got != wnt {
			t.Fatalf("got %s, want %s", got, wnt)
		}
	}
	l.onAck(3)
	if len(l.unacked) != 0 || l.unackedBytes != 0 {
		t.Fatalf("acked frames must be released: %d left, %d bytes", len(l.unacked), l.unackedBytes)
	}
}

func TestLinkDropsWorkOfAReplacedGateway(t *testing.T) {
	l := newLink()
	l.reset("E1")
	old := l.currentGen()
	l.reset("E2")
	if l.send(old, &Header{T: "out"}, nil, false) {
		t.Fatal("a frame from before the reset must not be sent")
	}
	if !l.send(l.currentGen(), &Header{T: "out"}, nil, false) {
		t.Fatal("a current frame must be sent")
	}
}

func TestLinkSequenceChecks(t *testing.T) {
	l := newLink()
	if ok, err := l.accept(&Header{S: 1}, 0); !ok || err != nil {
		t.Fatal("first frame must be delivered")
	}
	if ok, err := l.accept(&Header{S: 1}, 0); ok || err != nil {
		t.Fatal("a duplicate must be dropped quietly")
	}
	if _, err := l.accept(&Header{S: 3}, 0); err == nil {
		t.Fatal("a gap must be an error")
	}
}

// ── the daemon, end to end over its socket ────────────────────────────────────────────────────

func quickEnv(t *testing.T) {
	t.Helper()
	prev := captureEnv
	captureEnv = func() ([]string, string) { return cleanEnv(os.Environ()), "test" }
	t.Cleanup(func() { captureEnv = prev })
}

func testDaemon(t *testing.T, ns string) *daemon {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	quickEnv(t)
	d, err := startDaemon(ns, "v1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.shutdown("test over") })
	return d
}

type gateway struct {
	t     *testing.T
	conn  net.Conn
	r     *bufio.Reader
	seq   uint64
	recv  uint64
	hello *Header
}

func dialGateway(t *testing.T, sock, epoch string, seq, recv uint64) *gateway {
	t.Helper()
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	g := &gateway{t: t, conn: conn, r: bufio.NewReader(conn), seq: seq, recv: recv}
	if err := writeFrame(conn, &Header{T: "hello", Proto: protoVersion, Epoch: epoch, Recv: recv}, nil); err != nil {
		t.Fatal(err)
	}
	g.hello = g.raw(2 * time.Second)
	if g.hello.T != "welcome" {
		t.Fatalf("expected welcome, got %+v", g.hello)
	}
	return g
}

func (g *gateway) raw(timeout time.Duration) *Header {
	g.t.Helper()
	_ = g.conn.SetReadDeadline(time.Now().Add(timeout))
	h, _, err := readFrame(g.r)
	if err != nil {
		g.t.Fatal(err)
	}
	return h
}

func (g *gateway) send(h *Header, body []byte) {
	g.t.Helper()
	g.seq++
	h.S, h.A = g.seq, g.recv
	if err := writeFrame(g.conn, h, body); err != nil {
		g.t.Fatal(err)
	}
}

// next returns the next sequenced frame, skipping control frames and duplicates.
func (g *gateway) next(timeout time.Duration) (*Header, []byte) {
	g.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		_ = g.conn.SetReadDeadline(deadline)
		h, body, err := readFrame(g.r)
		if err != nil {
			g.t.Fatalf("reading: %v", err)
		}
		if h.S == 0 || h.S <= g.recv {
			continue
		}
		g.recv = h.S
		return h, body
	}
}

// until reads frames until one of type `typ` (optionally with id) arrives, collecting stdout.
func (g *gateway) until(typ, id string, timeout time.Duration) (*Header, []byte, string) {
	g.t.Helper()
	var out strings.Builder
	deadline := time.Now().Add(timeout)
	for {
		h, body := g.next(time.Until(deadline))
		if h.T == "out" && h.Fd == 1 {
			out.Write(body)
		}
		if h.T == typ && (id == "" || h.ID == id) {
			return h, body, out.String()
		}
	}
}

func (g *gateway) ack() {
	_ = writeFrame(g.conn, &Header{T: "ack", A: g.recv}, nil)
}

func TestSpawnEchoAndExit(t *testing.T) {
	d := testDaemon(t, "spawn")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	if g.hello.Resumed || g.hello.Home == "" || g.hello.Version != "v1" {
		t.Fatalf("welcome: %+v", g.hello)
	}
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "cat", Cwd: "~"}, nil)
	g.send(&Header{T: "stdin", ID: "p1"}, []byte("hello\n"))
	g.send(&Header{T: "stdin-end", ID: "p1"}, nil)
	h, _, out := g.until("exit", "p1", 5*time.Second)
	if out != "hello\n" || h.Code == nil || *h.Code != 0 {
		t.Fatalf("exit %+v, out %q", h, out)
	}
}

func TestAgentGetsShimOnPathAndSocket(t *testing.T) {
	d := testDaemon(t, "env")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "sh", Args: []string{"-c", `echo "$PATH|$TALKCODE_REMOTE_SOCK|$TALKCODE_REMOTE_CLI|$FOO"`}, Env: map[string]string{"FOO": "bar"}}, nil)
	_, _, out := g.until("exit", "p1", 5*time.Second)
	parts := strings.Split(strings.TrimSpace(out), "|")
	// TALKCODE_REMOTE_CLI is the absolute path of the shim, for the Node CLI that a login shell's
	// PATH reset can land on instead (remote/README.md, "Agents").
	if len(parts) != 4 || !strings.HasPrefix(parts[0], binDirFor("v1")+":") || parts[1] != d.sockPath ||
		parts[2] != filepath.Join(binDirFor("v1"), "talkcode") || parts[3] != "bar" {
		t.Fatalf("env seen by the agent: %q", out)
	}
}

func TestSpawnFailureIsAnExitWithAReason(t *testing.T) {
	d := testDaemon(t, "enoent")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "definitely-not-a-command-xyz"}, nil)
	h, _, _ := g.until("exit", "p1", 5*time.Second)
	if !strings.Contains(h.Error, "not found") {
		t.Fatalf("exit: %+v", h)
	}
}

func TestOutputSurvivesADroppedConnection(t *testing.T) {
	d := testDaemon(t, "resume")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "sh", Args: []string{"-c", "echo early; sleep 0.5; echo late"}}, nil)
	h, _, out := g.until("out", "p1", 5*time.Second)
	if h.T != "out" || out != "early\n" {
		t.Fatalf("before the drop: %q", out)
	}
	g.ack()
	time.Sleep(50 * time.Millisecond) // let the ack land before the connection goes
	g.conn.Close()

	time.Sleep(1 * time.Second) // the process finishes while nobody is connected
	g2 := dialGateway(t, d.sockPath, "E1", g.seq, g.recv)
	if !g2.hello.Resumed {
		t.Fatalf("same epoch must resume: %+v", g2.hello)
	}
	h, _, out = g2.until("exit", "p1", 5*time.Second)
	if out != "late\n" || h.Code == nil || *h.Code != 0 {
		t.Fatalf("after the reconnect: exit %+v, out %q", h, out)
	}
}

func TestUnackedOutputIsResentNotLost(t *testing.T) {
	d := testDaemon(t, "resend")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "sh", Args: []string{"-c", "echo one"}}, nil)
	g.until("exit", "p1", 5*time.Second)
	// Read everything but never acknowledge it, then come back claiming to have seen nothing.
	g.conn.Close()
	g2 := dialGateway(t, d.sockPath, "E1", g.seq, 0)
	_, _, out := g2.until("exit", "p1", 5*time.Second)
	if out != "one\n" {
		t.Fatalf("resent output: %q", out)
	}
}

func TestGatewayFramesAreDeduplicated(t *testing.T) {
	d := testDaemon(t, "dedupe")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "cat"}, nil)
	g.send(&Header{T: "stdin", ID: "p1"}, []byte("a"))
	// The same frame again, as a gateway resending after a reconnect would.
	_ = writeFrame(g.conn, &Header{T: "stdin", ID: "p1", S: g.seq}, []byte("a"))
	g.send(&Header{T: "stdin-end", ID: "p1"}, nil)
	_, _, out := g.until("exit", "p1", 5*time.Second)
	if out != "a" {
		t.Fatalf("a duplicate stdin frame must be ignored: %q", out)
	}
}

func TestANewGatewayStopsTheOldOnesAgents(t *testing.T) {
	d := testDaemon(t, "epoch")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "sleep", Args: []string{"30"}}, nil)
	h, _ := g.next(5 * time.Second)
	if h.T != "spawned" {
		t.Fatalf("expected spawned, got %+v", h)
	}
	pid := h.Pid
	g.conn.Close()
	g2 := dialGateway(t, d.sockPath, "E2", 0, 0)
	if g2.hello.Resumed {
		t.Fatal("a different epoch must not resume")
	}
	if !waitFor(5*time.Second, func() bool { return gone(pid) }) {
		t.Fatal("the old gateway's agent is still running")
	}
}

func TestSignalsReachTheProcess(t *testing.T) {
	d := testDaemon(t, "signal")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "sleep", Args: []string{"30"}}, nil)
	g.send(&Header{T: "signal", ID: "p1", Sig: "SIGINT"}, nil) // may land before the start completes
	h, _, _ := g.until("exit", "p1", 5*time.Second)
	if h.Signal != "SIGINT" {
		t.Fatalf("exit: %+v", h)
	}
}

func TestFd3ReachesTheGateway(t *testing.T) {
	d := testDaemon(t, "fd3")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "sh", Args: []string{"-c", "echo status >&3"}, Fd3: true}, nil)
	var got string
	for {
		h, body := g.next(5 * time.Second)
		if h.T == "out" && h.Fd == 3 {
			got += string(body)
		}
		if h.T == "exit" {
			break
		}
	}
	if got != "status\n" {
		t.Fatalf("fd 3: %q", got)
	}
}

func TestReverseCommandRoundTrip(t *testing.T) {
	d := testDaemon(t, "cli")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)

	shim, err := net.Dial("unix", d.sockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer shim.Close()
	_ = writeFrame(shim, &Header{T: "cli", Argv: []string{"send-message", "hi"}, Cwd: "/w", Token: "tok", Env: map[string]string{"TALKCODE_CWD": "/w"}}, nil)
	_ = writeFrame(shim, &Header{T: "in"}, []byte("stdin-bytes"))
	_ = writeFrame(shim, &Header{T: "in-end"}, nil)

	open, _ := g.next(5 * time.Second)
	if open.T != "cli-open" || open.Token != "tok" || strings.Join(open.Argv, " ") != "send-message hi" || open.Env["TALKCODE_CWD"] != "/w" {
		t.Fatalf("cli-open: %+v", open)
	}
	in, body := g.next(5 * time.Second)
	if in.T != "cli-in" || in.Cid != open.Cid || string(body) != "stdin-bytes" {
		t.Fatalf("cli-in: %+v %q", in, body)
	}
	end, _ := g.next(5 * time.Second)
	if end.T != "cli-in-end" {
		t.Fatalf("cli-in-end: %+v", end)
	}
	g.send(&Header{T: "cli-out", Cid: open.Cid, Fd: 1}, []byte("sent\n"))
	g.send(&Header{T: "cli-exit", Cid: open.Cid, Code: intPtr(3)}, nil)

	r := bufio.NewReader(shim)
	_ = shim.SetReadDeadline(time.Now().Add(5 * time.Second))
	h, b, err := readFrame(r)
	if err != nil || h.T != "out" || string(b) != "sent\n" {
		t.Fatalf("shim out: %+v %q %v", h, b, err)
	}
	h, _, err = readFrame(r)
	if err != nil || h.T != "exit" || h.Code == nil || *h.Code != 3 {
		t.Fatalf("shim exit: %+v %v", h, err)
	}
}

func rpc(t *testing.T, g *gateway, h *Header, body []byte) (*Header, map[string]any, []byte) {
	t.Helper()
	h.T = "rpc"
	h.Rid = "r" + itoa(g.seq+1)
	g.send(h, body)
	for {
		r, b := g.next(10 * time.Second)
		if r.Rid != h.Rid {
			continue
		}
		var res map[string]any
		if len(r.Res) > 0 {
			_ = json.Unmarshal(r.Res, &res)
		}
		return r, res, b
	}
}

func TestFileOperations(t *testing.T) {
	d := testDaemon(t, "ops")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)

	r, _, _ := rpc(t, g, &Header{Op: "writeFile", Path: "~/a/b/file.txt"}, []byte("one\n"))
	if r.T != "rpc-ok" {
		t.Fatalf("writeFile: %+v", r)
	}
	rpc(t, g, &Header{Op: "writeFile", Path: "~/a/b/file.txt", Append: true}, []byte("two\n"))
	r, res, body := rpc(t, g, &Header{Op: "readFile", Path: "~/a/b/file.txt"}, nil)
	if r.T != "rpc-ok" || string(body) != "one\ntwo\n" || res["size"] != float64(8) {
		t.Fatalf("readFile: %+v %v %q", r, res, body)
	}
	_, _, body = rpc(t, g, &Header{Op: "readFile", Path: "~/a/b/file.txt", Offset: 4, Max: 2}, nil)
	if string(body) != "tw" {
		t.Fatalf("readFile chunk: %q", body)
	}
	st, err := os.Stat(filepath.Join(homeDir(), "a", "b", "file.txt"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("an attachment must be owner-only: %v %v", st.Mode(), err)
	}

	_, res, _ = rpc(t, g, &Header{Op: "stat", Path: "~/a"}, nil)
	if res["exists"] != true || res["dir"] != true {
		t.Fatalf("stat: %v", res)
	}
	_, res, _ = rpc(t, g, &Header{Op: "stat", Path: "~/nope"}, nil)
	if res["exists"] != false {
		t.Fatalf("stat missing: %v", res)
	}
	r, _, _ = rpc(t, g, &Header{Op: "readFile", Path: "~/nope"}, nil)
	if r.T != "rpc-err" {
		t.Fatalf("reading a missing file must fail: %+v", r)
	}

	_ = os.MkdirAll(filepath.Join(homeDir(), "ws", "proj"), 0o755)
	_ = os.Symlink(filepath.Join(homeDir(), "a"), filepath.Join(homeDir(), "ws", "linked"))
	_ = os.WriteFile(filepath.Join(homeDir(), "ws", "file"), nil, 0o600)
	_, res, _ = rpc(t, g, &Header{Op: "listDir", Path: "~/ws"}, nil)
	var got []string
	for _, e := range res["entries"].([]any) {
		m := e.(map[string]any)
		got = append(got, m["name"].(string)+"="+map[bool]string{true: "dir", false: "file"}[m["dir"].(bool)])
	}
	if strings.Join(got, " ") != "file=file linked=dir proj=dir" {
		t.Fatalf("listDir must follow links: %v", got)
	}
}

func TestReadTailFiltersOnTheHost(t *testing.T) {
	d := testDaemon(t, "tail")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	content := "first-partial usage\nkeep usage 1\nnoise\nkeep usage 2\n"
	_ = os.WriteFile(filepath.Join(homeDir(), "t.jsonl"), []byte("x"+content), 0o600)
	_, res, body := rpc(t, g, &Header{Op: "readTail", Path: "~/t.jsonl", Max: int64(len(content)), Grep: []string{"keep"}}, nil)
	if string(body) != "keep usage 1\nkeep usage 2" || res["truncated"] != true {
		t.Fatalf("readTail: %v %q", res, body)
	}
}

func TestReadTailProjectsJSONFields(t *testing.T) {
	d := testDaemon(t, "project")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	lines := `{"type":"user","timestamp":"t1","message":{"content":"` + strings.Repeat("x", 5000) + `"}}` + "\n" +
		`not json` + "\n" +
		`{"type":"assistant","timestamp":"t2","message":{"id":"m1","usage":{"input_tokens":3},"content":"big"}}` + "\n"
	_ = os.WriteFile(filepath.Join(homeDir(), "s.jsonl"), []byte(lines), 0o600)
	_, _, body := rpc(t, g, &Header{Op: "readTail", Path: "~/s.jsonl", Max: 1 << 20, Fields: []string{"type", "timestamp", "message.id", "message.usage"}}, nil)
	want := `{"timestamp":"t1","type":"user"}` + "\n" + `{"message":{"id":"m1","usage":{"input_tokens":3}},"timestamp":"t2","type":"assistant"}`
	if string(body) != want {
		t.Fatalf("projected tail:\n%s\nwant\n%s", body, want)
	}
}

func TestEnsureLink(t *testing.T) {
	d := testDaemon(t, "link")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	link := func() string {
		_, res, _ := rpc(t, g, &Header{Op: "ensureLink", Target: "~/skill", Path: "~/.claude/skills/talkcode", Requires: "~/.claude"}, nil)
		return res["outcome"].(string)
	}
	if got := link(); got != "skipped" {
		t.Fatalf("without the harness's directory: %s", got)
	}
	_ = os.MkdirAll(filepath.Join(homeDir(), ".claude"), 0o755)
	if got := link(); got != "linked" {
		t.Fatalf("first link: %s", got)
	}
	if got := link(); got != "current" {
		t.Fatalf("second link: %s", got)
	}
	_ = os.Remove(filepath.Join(homeDir(), ".claude", "skills", "talkcode"))
	_ = os.MkdirAll(filepath.Join(homeDir(), ".claude", "skills", "talkcode"), 0o755)
	if got := link(); got != "occupied" {
		t.Fatalf("over a real directory: %s", got)
	}
}

// An instructions link sits at a harness's own global file, where a symlink may be the operator's:
// with `owned`, only a link into that directory is ours to repoint.
func TestEnsureLinkOwnedLeavesTheOperatorsLink(t *testing.T) {
	d := testDaemon(t, "owned")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	home := homeDir()
	_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o755)
	agents := filepath.Join(home, ".codex", "AGENTS.md")
	link := func(target string) map[string]any {
		_, res, _ := rpc(t, g, &Header{Op: "ensureLink", Target: target, Path: "~/.codex/AGENTS.md", Requires: "~/.codex", Owned: "~/.talkcode/instructions"}, nil)
		return res
	}

	_ = os.Symlink(filepath.Join(home, "notes", "codex.md"), agents)
	if res := link("~/.talkcode/instructions/codex.md"); res["outcome"] != "occupied" || !strings.Contains(res["detail"].(string), "notes") {
		t.Fatalf("over the operator's link: %v", res)
	}
	_ = os.Remove(agents)
	_ = os.Symlink(filepath.Join(home, ".talkcode", "instructions", "old.md"), agents)
	if res := link("~/.talkcode/instructions/codex.md"); res["outcome"] != "relinked" {
		t.Fatalf("over a link of ours: %v", res)
	}
	if dest, _ := os.Readlink(agents); dest != filepath.Join(home, ".talkcode", "instructions", "codex.md") {
		t.Fatalf("points at %s", dest)
	}
}

func TestRemoveLinkTakesBackOnlyItsOwn(t *testing.T) {
	d := testDaemon(t, "unlink")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	home := homeDir()
	_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o755)
	agents := filepath.Join(home, ".codex", "AGENTS.md")
	remove := func() string {
		_, res, _ := rpc(t, g, &Header{Op: "removeLink", Path: "~/.codex/AGENTS.md", Owned: "~/.talkcode/instructions"}, nil)
		return res["outcome"].(string)
	}

	if got := remove(); got != "absent" {
		t.Fatalf("nothing there: %s", got)
	}
	_ = os.WriteFile(agents, []byte("mine"), 0o644)
	if got := remove(); got != "kept" {
		t.Fatalf("a real file: %s", got)
	}
	_ = os.Remove(agents)
	_ = os.Symlink(filepath.Join(home, "notes", "codex.md"), agents)
	if got := remove(); got != "kept" {
		t.Fatalf("the operator's link: %s", got)
	}
	_ = os.Remove(agents)
	_ = os.Symlink(filepath.Join(home, ".talkcode", "instructions", "codex.md"), agents)
	if got := remove(); got != "removed" {
		t.Fatalf("a link of ours: %s", got)
	}
	if _, err := os.Lstat(agents); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("still there: %v", err)
	}
	if r, _, _ := rpc(t, g, &Header{Op: "removeLink", Path: "~/.codex/AGENTS.md"}, nil); r.T != "rpc-err" {
		t.Fatalf("without `owned` it must refuse, not remove anything: %+v", r)
	}
}

// The instructions copy is replaced while agents may be starting and reading it, and is kept
// read-only: an atomic write lands whole, over a 0444 file, and leaves no temporary behind.
func TestWriteFileAtomicReplacesAReadOnlyFile(t *testing.T) {
	d := testDaemon(t, "atomic")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	file := filepath.Join(homeDir(), ".talkcode", "instructions", "codex.md")
	write := func(text string) *Header {
		r, _, _ := rpc(t, g, &Header{Op: "writeFile", Path: "~/.talkcode/instructions/codex.md", Mode: 0o444, Atomic: true}, []byte(text))
		return r
	}

	for _, text := range []string{"first\n", "second\n"} {
		if r := write(text); r.T != "rpc-ok" {
			t.Fatalf("write %q: %+v", text, r)
		}
		got, _ := os.ReadFile(file)
		st, _ := os.Stat(file)
		if string(got) != text || st.Mode().Perm() != 0o444 {
			t.Fatalf("after writing %q: %q %v", text, got, st.Mode().Perm())
		}
	}
	entries, _ := os.ReadDir(filepath.Dir(file))
	if len(entries) != 1 {
		t.Fatalf("left something behind: %v", entries)
	}
	if r, _, _ := rpc(t, g, &Header{Op: "writeFile", Path: "~/.talkcode/instructions/codex.md", Atomic: true, Append: true}, []byte("x")); r.T != "rpc-err" {
		t.Fatalf("an atomic append must be refused: %+v", r)
	}
}

// The managed-skill copy is pruned and, when archived, removed whole — but only inside the copy
// directory the gateway owns. A symlinked directory is not a way out of it.
func TestRemovePathStaysInRoot(t *testing.T) {
	d := testDaemon(t, "removepath")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	home := homeDir()
	copyDir := filepath.Join(home, ".talkcode", "skills", "foo")
	_ = os.MkdirAll(filepath.Join(copyDir, "references"), 0o755)
	_ = os.WriteFile(filepath.Join(copyDir, "SKILL.md"), []byte("x"), 0o600)
	_ = os.WriteFile(filepath.Join(copyDir, "references", "a.md"), []byte("a"), 0o600)
	remove := func(path, owned string) (*Header, map[string]any) {
		r, res, _ := rpc(t, g, &Header{Op: "removePath", Path: path, Owned: owned}, nil)
		return r, res
	}

	r, res := remove("~/.talkcode/skills/foo/references/a.md", "~/.talkcode/skills/foo")
	if r.T != "rpc-ok" || res["removed"] != true {
		t.Fatalf("remove a file: %+v %v", r, res)
	}
	if _, err := os.Lstat(filepath.Join(copyDir, "references", "a.md")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("file still there: %v", err)
	}
	if r, res := remove("~/.talkcode/skills/foo/references/missing.md", "~/.talkcode/skills/foo"); res["removed"] != false {
		t.Fatalf("missing file: %+v %v", r, res)
	}
	if r, _ := remove("~/.talkcode/skills/foo", "~/.talkcode/skills/foo"); r.T != "rpc-err" {
		t.Fatalf("the root itself must be refused: %+v", r)
	}
	if r, _ := remove("~/.talkcode/elsewhere", "~/.talkcode/skills/foo"); r.T != "rpc-err" {
		t.Fatalf("outside the root must be refused: %+v", r)
	}

	// A symlinked subdirectory cannot carry the delete outside the copy.
	outside := filepath.Join(home, "outside")
	_ = os.MkdirAll(outside, 0o755)
	_ = os.WriteFile(filepath.Join(outside, "keep"), []byte("keep"), 0o600)
	_ = os.Symlink(outside, filepath.Join(copyDir, "sub"))
	if r, _ := remove("~/.talkcode/skills/foo/sub/keep", "~/.talkcode/skills/foo"); r.T != "rpc-err" {
		t.Fatalf("a symlinked parent must be refused: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep")); err != nil {
		t.Fatalf("deleted outside the copy: %v", err)
	}

	// The copy itself goes when its parent is the root.
	if r, res := remove("~/.talkcode/skills/foo", "~/.talkcode/skills"); r.T != "rpc-ok" || res["removed"] != true {
		t.Fatalf("remove the copy: %+v %v", r, res)
	}
	if _, err := os.Lstat(copyDir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("copy still there: %v", err)
	}
}

func TestListFilesRelative(t *testing.T) {
	d := testDaemon(t, "listfiles")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	home := homeDir()
	dir := filepath.Join(home, ".talkcode", "skills", "foo")
	_ = os.MkdirAll(filepath.Join(dir, "references"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("x"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "references", "a.md"), []byte("a"), 0o600)
	_ = os.Symlink(filepath.Join(home, "outside"), filepath.Join(dir, "outside-link"))

	_, res, _ := rpc(t, g, &Header{Op: "listFiles", Path: "~/.talkcode/skills/foo"}, nil)
	files, _ := res["files"].([]any)
	got := make([]string, 0, len(files))
	for _, f := range files {
		got = append(got, f.(string))
	}
	sort.Strings(got)
	want := []string{"SKILL.md", "outside-link", "references/a.md"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("files %v, want %v", got, want)
	}
	if _, res, _ := rpc(t, g, &Header{Op: "listFiles", Path: "~/.talkcode/skills/none"}, nil); len(res["files"].([]any)) != 0 {
		t.Fatalf("a missing directory: %v", res)
	}
}

func TestSweepSkillLinks(t *testing.T) {
	d := testDaemon(t, "sweep")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	home := homeDir()
	skills := filepath.Join(home, ".codebuddy", "skills")
	_ = os.MkdirAll(skills, 0o755)
	_ = os.MkdirAll(filepath.Join(home, ".talkcode", "remote", "2.22.0-live", "skill"), 0o755)

	// What an upgrade leaves behind: a link into a version directory that no longer exists. The
	// other two are the ones it must not touch — a link into the running version, and the
	// operator's own link somewhere else.
	dead := filepath.Join(skills, "talkcode")
	live := filepath.Join(skills, "super")
	mine := filepath.Join(skills, "notes")
	_ = os.Symlink(filepath.Join(home, ".talkcode", "remote", "2.17.0-gone", "skill"), dead)
	_ = os.Symlink(filepath.Join(home, ".talkcode", "remote", "2.22.0-live", "skill"), live)
	_ = os.Symlink(filepath.Join(home, "elsewhere"), mine)

	_, res, _ := rpc(t, g, &Header{Op: "sweepSkillLinks", Path: "~/.codebuddy/skills"}, nil)
	removed, _ := res["removed"].([]any)
	if len(removed) != 1 || removed[0] != dead {
		t.Fatalf("removed %v, want only %s", removed, dead)
	}
	if _, err := os.Lstat(dead); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("dead link still there: %v", err)
	}
	for _, keep := range []string{live, mine} {
		if _, err := os.Lstat(keep); err != nil {
			t.Fatalf("removed a link it does not own: %s (%v)", keep, err)
		}
	}
}

func TestRunCollectsOutputAndKillsTheGroupOnTimeout(t *testing.T) {
	d := testDaemon(t, "run")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	_, res, body := rpc(t, g, &Header{Op: "run", Argv: []string{"sh", "-c", "echo out; echo err >&2; exit 4"}}, nil)
	if string(body) != "out\n" || res["code"] != float64(4) || res["stderr"] != "err" {
		t.Fatalf("run: %v %q", res, body)
	}
	_, res, body = rpc(t, g, &Header{Op: "run", Bash: "echo a; echo b >&2", Merge: true}, nil)
	if string(body) != "a\nb\n" || res["code"] != float64(0) {
		t.Fatalf("merged run: %v %q", res, body)
	}
	// The request body is stdin: how a one-shot agy gets a prompt too long for one argv entry.
	_, res, body = rpc(t, g, &Header{Op: "run", Argv: []string{"cat"}}, []byte("from the gateway\n"))
	if string(body) != "from the gateway\n" || res["code"] != float64(0) {
		t.Fatalf("stdin: %v %q", res, body)
	}
	big := bytes.Repeat([]byte("x"), 200<<10)
	_, res, body = rpc(t, g, &Header{Op: "run", Argv: []string{"wc", "-c"}}, big)
	if strings.TrimSpace(string(body)) != "204800" || res["code"] != float64(0) {
		t.Fatalf("large stdin: %v %q", res, body)
	}
	marker := filepath.Join(homeDir(), "child-alive")
	start := time.Now()
	_, res, _ = rpc(t, g, &Header{Op: "run", Bash: "(sleep 5; touch " + marker + ") & sleep 30", TimeoutMs: 300}, nil)
	if res["timedOut"] != true || time.Since(start) > 5*time.Second {
		t.Fatalf("timeout: %v after %v", res, time.Since(start))
	}
	time.Sleep(5500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the background child of a timed-out run survived")
	}
	_, res, _ = rpc(t, g, &Header{Op: "run", Argv: []string{"no-such-command-xyz"}}, nil)
	if res["spawnError"] == nil {
		t.Fatalf("spawn error: %v", res)
	}
}

// ── attach: versions ──────────────────────────────────────────────────────────────────────────

func TestANewVersionRetiresTheOldDaemonAndItsDirectory(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"v1", "v2", "v0"} {
		_ = os.MkdirAll(versionDir(v), 0o700)
		_ = os.WriteFile(filepath.Join(versionDir(v), "talkcode-remote"), nil, 0o700)
	}
	sock, err := ensureDaemon(self, "ns1", "v1")
	if err != nil {
		t.Fatal(err)
	}
	st1, err := daemonStatus(sock)
	if err != nil || st1.Version != "v1" {
		t.Fatalf("v1 status: %+v %v", st1, err)
	}
	if again, err := ensureDaemon(self, "ns1", "v1"); err != nil || again != sock {
		t.Fatalf("the same version must reuse the daemon: %v", err)
	}
	if st, _ := daemonStatus(sock); st == nil || st.Pid != st1.Pid {
		t.Fatal("the same version must not restart the daemon")
	}

	if _, err := ensureDaemon(self, "ns1", "v2"); err != nil {
		t.Fatal(err)
	}
	st2, err := daemonStatus(sock)
	if err != nil || st2.Version != "v2" || st2.Pid == st1.Pid {
		t.Fatalf("v2 status: %+v %v", st2, err)
	}
	if !waitFor(3*time.Second, func() bool { return gone(st1.Pid) }) {
		t.Fatal("the v1 daemon is still running")
	}
	removeUnusedVersions("v2")
	for v, want := range map[string]bool{"v0": false, "v1": false, "v2": true} {
		if _, err := os.Stat(versionDir(v)); (err == nil) != want {
			t.Fatalf("version dir %s: exists=%v, want %v", v, err == nil, want)
		}
	}

	c, _ := net.Dial("unix", sock)
	_ = writeFrame(c, &Header{T: "ctl", Op: "shutdown"}, nil)
	c.Close()
	waitFor(3*time.Second, func() bool { return !alive(sock) })
}

func TestParseDumpEnvIgnoresBanners(t *testing.T) {
	out := []byte("Welcome!\n" + envBegin + `["A=1","B=two words"]` + envEnd + "\nbye\n")
	env, ok := parseDumpEnv(out)
	if !ok || len(env) != 2 || env[1] != "B=two words" {
		t.Fatalf("parse: %v %v", env, ok)
	}
	if _, ok := parseDumpEnv([]byte("no markers")); ok {
		t.Fatal("output without markers must be rejected")
	}
}

func TestCaptureLoginEnvReadsTheShell(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHELL", "/bin/bash")
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("no bash")
	}
	_ = os.WriteFile(filepath.Join(home, ".bashrc"), []byte("export FROM_BASHRC=yes\n"), 0o600)
	_ = os.WriteFile(filepath.Join(home, ".bash_profile"), []byte(". ~/.bashrc\n"), 0o600)
	env, how := captureLoginEnv()
	if envGet(env, "FROM_BASHRC") != "yes" {
		t.Fatalf("the rc file's export is missing (%s)", how)
	}
	if envGet(env, "SSH_CONNECTION") != "" || envGet(env, "SHLVL") != "" {
		t.Fatal("connection and shell bookkeeping must be dropped")
	}
}

// gone reports a pid that no longer runs — exited, or a zombie: under `go test` the daemons this
// test starts are this process's children, and nobody reaps them until the test binary exits.
func gone(pid int) bool {
	b, err := os.ReadFile("/proc/" + itoa(uint64(pid)) + "/stat")
	if err != nil {
		return syscall.Kill(pid, 0) != nil
	}
	fields := strings.Fields(string(b[bytes.LastIndexByte(b, ')')+1:]))
	return len(fields) > 0 && fields[0] == "Z"
}

func waitFor(d time.Duration, f func() bool) bool {
	for deadline := time.Now().Add(d); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if f() {
			return true
		}
	}
	return f()
}

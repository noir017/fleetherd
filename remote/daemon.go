package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
)

// The resident daemon: one per (gateway, version) on this host, outliving every ssh connection.
//
// It owns the agents and the reliable link state (link.go), so a connection that drops costs the
// agents nothing: they keep running, their output waits in `unacked`, and the gateway's next
// connection — through a fresh `attach` — picks up where the last one stopped. What does reset
// everything is a DIFFERENT gateway epoch: a restarted gateway has no memory of these agents and
// no way to resume them, so they are stopped rather than left running for nobody.
//
// Three kinds of connection arrive on its socket, told apart by their first frame:
//   hello — the gateway, through attach (the link)
//   cli   — the `talkcode` shim an agent ran (a reverse command or the native-tools server)
//   ctl   — attach asking about or stopping this daemon (status / shutdown)

const (
	protoVersion = 1
	// No gateway and nothing running for this long: exit, and let the next attach start a fresh one.
	idleExit = 10 * time.Minute
	// No gateway for this long, even with agents running: stop them and exit. A day covers any
	// outage worth waiting out; past it the gateway is gone, and the agents have nobody to answer.
	orphanTTL = 24 * time.Hour
)

type cliConn struct {
	cid    string
	gen    uint64
	conn   net.Conn
	w      *connWriter
	exited bool
}

type daemon struct {
	ns, version string
	instance    string
	sockPath    string
	binDir      string
	link        *link
	env         *shellEnv
	ln          net.Listener

	mu         sync.Mutex
	procs      map[string]*proc
	rpcs       map[string]context.CancelFunc
	clis       map[string]*cliConn
	nextCid    uint64
	linkConn   net.Conn
	detachedAt time.Time

	quit     chan struct{}
	quitOnce sync.Once
}

func logf(format string, args ...any) { log.Printf(format, args...) }

func randomID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func runDaemon(args []string) int {
	fs := flag.NewFlagSet("daemon", flag.ContinueOnError)
	ns := fs.String("ns", "", "gateway namespace")
	version := fs.String("version", "", "version directory name")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !safeName.MatchString(*ns) || !safeName.MatchString(*version) {
		fmt.Fprintln(os.Stderr, "daemon: --ns and --version are required")
		return 2
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	d, err := startDaemon(*ns, *version)
	if err != nil {
		logf("cannot start: %v", err)
		return 1
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	signal.Ignore(syscall.SIGHUP, syscall.SIGPIPE)
	go func() {
		s := <-sigs
		d.shutdown("received " + s.String())
	}()
	<-d.quit
	return 0
}

func startDaemon(ns, version string) (*daemon, error) {
	dir := runDirFor(ns)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	sock := sockPathFor(ns)
	if alive(sock) {
		return nil, fmt.Errorf("a daemon is already listening on %s", sock)
	}
	_ = os.Remove(sock)
	old := syscall.Umask(0o077)
	ln, err := net.Listen("unix", sock)
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(sock, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "daemon.pid"), []byte(itoa(uint64(os.Getpid()))+"\n"), 0o600)

	d := &daemon{
		ns: ns, version: version, instance: randomID(), sockPath: sock, binDir: binDirFor(version),
		link: newLink(), env: &shellEnv{capture: captureEnv}, ln: ln,
		procs: map[string]*proc{}, rpcs: map[string]context.CancelFunc{}, clis: map[string]*cliConn{},
		detachedAt: time.Now(), quit: make(chan struct{}),
	}
	logf("daemon %s (version %s, ns %s) listening on %s", d.instance, version, ns, sock)
	go d.env.get() // warm the login environment before the first agent asks for it
	go d.acceptLoop()
	go d.idleLoop()
	return d, nil
}

// agentEnv is the environment for anything this daemon starts: the login environment, the
// gateway's per-agent overrides, the `talkcode` shim leading PATH, the socket the shim dials, and
// the shim's own path.
//
// TALKCODE_REMOTE_CLI exists because PATH is not reliable where an agent runs commands: codex runs
// them with `bash -lc`, and a login shell re-reads /etc/profile, which rebuilds PATH from the
// system default — so `talkcode` there is whatever the image installed (the full Node CLI in
// uniagent) rather than the shim this daemon put first. The Node CLI cannot work out where the
// shim is from the socket alone (the socket is per gateway, the shim per version), so the daemon
// says it: with this variable set the Node CLI hands its argv straight to the shim instead of
// looking for a config file that is not on this machine. An environment variable, unlike PATH,
// survives the login shell.
func (d *daemon) agentEnv(set map[string]string, unset []string) []string {
	env := envMerge(d.env.get(), set, unset)
	path := envGet(env, "PATH")
	if path == "" {
		path = d.binDir
	} else {
		path = d.binDir + string(os.PathListSeparator) + path
	}
	return envMerge(env, map[string]string{
		"PATH":                 path,
		"TALKCODE_REMOTE_SOCK": d.sockPath,
		"TALKCODE_REMOTE_CLI":  filepath.Join(d.binDir, "talkcode"),
	}, nil)
}

func (d *daemon) acceptLoop() {
	for {
		conn, err := d.ln.Accept()
		if err != nil {
			select {
			case <-d.quit:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			logf("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go d.serveConn(conn)
	}
}

func (d *daemon) serveConn(conn net.Conn) {
	r := bufio.NewReaderSize(conn, 64<<10)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	h, _, err := readFrame(r)
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil {
		conn.Close()
		return
	}
	switch h.T {
	case "hello":
		d.serveLink(conn, r, h)
	case "cli":
		d.serveCli(conn, r, h)
	case "ctl":
		d.serveCtl(conn, h)
	default:
		logf("unknown first frame %q; closing", h.T)
		conn.Close()
	}
}

// ── the gateway link ──────────────────────────────────────────────────────────────────────────

func (d *daemon) serveLink(conn net.Conn, r *bufio.Reader, hello *Header) {
	defer conn.Close()
	if hello.Proto != protoVersion {
		_ = writeFrame(conn, &Header{T: "welcome", Proto: protoVersion, Error: fmt.Sprintf("protocol %d is not supported (this daemon speaks %d)", hello.Proto, protoVersion)}, nil)
		return
	}
	d.mu.Lock()
	if d.linkConn != nil {
		d.linkConn.Close() // the newest connection wins: the old one is a dead route not yet noticed
	}
	d.linkConn = conn
	d.mu.Unlock()

	resumed := hello.Epoch != "" && hello.Epoch == d.currentEpoch()
	peerRecv := hello.Recv
	if !resumed {
		d.resetAll(hello.Epoch, "a new gateway connected")
		peerRecv = 0
	}
	w := newConnWriter(conn, func(error) { conn.Close() })
	welcome := &Header{
		T: "welcome", Proto: protoVersion, Version: d.version, Instance: d.instance, Resumed: resumed,
		Home: homeDir(), Pid: os.Getpid(), OS: runtime.GOOS, Arch: runtime.GOARCH,
	}
	if err := d.link.attach(w, peerRecv, welcome); err != nil {
		logf("link: %v", err)
		return
	}
	logf("gateway connected (epoch %s, resumed %v)", hello.Epoch, resumed)

	err := d.readLink(r)
	d.link.detach(w)
	d.mu.Lock()
	if d.linkConn == conn {
		d.linkConn = nil
		d.detachedAt = time.Now()
	}
	d.mu.Unlock()
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		logf("gateway connection ended: %v", err)
	} else {
		logf("gateway connection ended")
	}
}

func (d *daemon) currentEpoch() string {
	d.link.mu.Lock()
	defer d.link.mu.Unlock()
	return d.link.epoch
}

func (d *daemon) readLink(r *bufio.Reader) error {
	for {
		h, body, err := readFrame(r)
		if err != nil {
			return err
		}
		d.link.onAck(h.A)
		switch h.T {
		case "ping":
			d.link.control(&Header{T: "pong", N: h.N})
			continue
		case "ack":
			continue
		}
		if h.S == 0 {
			logf("ignoring unsequenced %q frame", h.T)
			continue
		}
		ok, err := d.link.accept(h, len(body))
		if err != nil {
			return err
		}
		if ok {
			d.dispatch(d.link.currentGen(), h, body)
		}
	}
}

// dispatch runs one sequenced frame from the gateway. It must not block: anything slow (starting a
// process, an operation) runs on its own goroutine, while everything ORDER-sensitive (a process's
// stdin, its signals) is queued here, synchronously, in the order it arrived.
func (d *daemon) dispatch(gen uint64, h *Header, body []byte) {
	switch h.T {
	case "spawn":
		d.mu.Lock()
		if _, dup := d.procs[h.ID]; dup || h.ID == "" {
			d.mu.Unlock()
			d.link.send(gen, &Header{T: "exit", ID: h.ID, Error: "duplicate or empty process id"}, nil, false)
			return
		}
		p := newProc(d, gen, h.ID)
		d.procs[h.ID] = p
		d.mu.Unlock()
		go p.start(h)
	case "stdin", "stdin-end", "signal":
		p := d.lookupProc(h.ID)
		if p == nil {
			return // already exited; its exit frame is on its way
		}
		switch h.T {
		case "stdin":
			p.stdin.push(body)
		case "stdin-end":
			p.stdin.end()
		default:
			p.signal(h.Sig)
		}
	case "rpc":
		go d.handleRPC(gen, h, body)
	case "rpc-cancel":
		d.mu.Lock()
		cancel := d.rpcs[h.Rid]
		d.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	case "cli-out", "cli-exit":
		d.toCli(h, body)
	case "shutdown":
		go d.shutdown("the gateway asked")
	default:
		logf("ignoring unknown frame %q", h.T)
	}
}

func (d *daemon) lookupProc(id string) *proc {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.procs[id]
}

func (d *daemon) forgetProc(p *proc) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.procs[p.id] == p {
		delete(d.procs, p.id)
	}
}

// resetAll stops everything begun for the previous gateway. Their late frames are dropped by the
// generation check in link.send, so none of it reaches the new one.
func (d *daemon) resetAll(epoch, why string) {
	d.link.reset(epoch)
	d.mu.Lock()
	procs, rpcs, clis := d.procs, d.rpcs, d.clis
	d.procs, d.rpcs, d.clis = map[string]*proc{}, map[string]context.CancelFunc{}, map[string]*cliConn{}
	d.mu.Unlock()
	if n := len(procs) + len(clis); n > 0 {
		logf("stopping %d process(es) and %d reverse command(s): %s", len(procs), len(clis), why)
	}
	for _, p := range procs {
		p.terminate()
	}
	for _, cancel := range rpcs {
		cancel()
	}
	for _, c := range clis {
		c.conn.Close()
	}
}

// ── the `talkcode` shim ───────────────────────────────────────────────────────────────────────

func (d *daemon) serveCli(conn net.Conn, r *bufio.Reader, first *Header) {
	defer conn.Close()
	gen := d.link.currentGen()
	d.mu.Lock()
	d.nextCid++
	c := &cliConn{cid: "c" + itoa(d.nextCid), gen: gen, conn: conn}
	c.w = newConnWriter(conn, func(error) { conn.Close() })
	d.clis[c.cid] = c
	d.mu.Unlock()

	d.link.send(gen, &Header{T: "cli-open", Cid: c.cid, Argv: first.Argv, Cwd: first.Cwd, Token: first.Token, Env: first.Env}, nil, false)
	for {
		h, body, err := readFrame(r)
		if err != nil {
			break
		}
		switch h.T {
		case "in":
			d.link.send(gen, &Header{T: "cli-in", Cid: c.cid}, body, false)
		case "in-end":
			d.link.send(gen, &Header{T: "cli-in-end", Cid: c.cid}, nil, false)
		}
	}
	d.mu.Lock()
	exited := c.exited
	if d.clis[c.cid] == c {
		delete(d.clis, c.cid)
	}
	d.mu.Unlock()
	if !exited {
		d.link.send(gen, &Header{T: "cli-gone", Cid: c.cid}, nil, false)
		c.w.close() // the shim is gone: nothing queued for it can be delivered
	}
	<-c.w.done
}

func (d *daemon) toCli(h *Header, body []byte) {
	d.mu.Lock()
	c := d.clis[h.Cid]
	if c != nil && h.T == "cli-exit" {
		c.exited = true
	}
	d.mu.Unlock()
	if c == nil {
		return
	}
	if h.T == "cli-out" {
		if buf, err := encodeFrame(&Header{T: "out", Fd: h.Fd}, body); err == nil {
			c.w.push(buf)
		}
		return
	}
	code := 0
	if h.Code != nil {
		code = *h.Code
	}
	if buf, err := encodeFrame(&Header{T: "exit", Code: intPtr(code)}, nil); err == nil {
		c.w.push(buf)
	}
	c.w.closeAfterDrain()
	go func() {
		<-c.w.done
		c.conn.Close()
	}()
}

// ── control ───────────────────────────────────────────────────────────────────────────────────

func (d *daemon) serveCtl(conn net.Conn, h *Header) {
	defer conn.Close()
	switch h.Op {
	case "status":
		d.mu.Lock()
		n := len(d.procs)
		connected := d.linkConn != nil
		d.mu.Unlock()
		_ = writeFrame(conn, &Header{T: "status", Version: d.version, Instance: d.instance, Pid: os.Getpid(), N: uint64(n), Resumed: connected}, nil)
	case "shutdown":
		_ = writeFrame(conn, &Header{T: "ok"}, nil)
		go d.shutdown("asked to make way for version " + h.Version)
	default:
		_ = writeFrame(conn, &Header{T: "error", Error: "unknown op " + h.Op}, nil)
	}
}

// ── lifetime ──────────────────────────────────────────────────────────────────────────────────

func (d *daemon) idleLoop() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-d.quit:
			return
		case <-t.C:
		}
		d.mu.Lock()
		connected := d.linkConn != nil
		busy := len(d.procs) + len(d.clis) + len(d.rpcs)
		since := time.Since(d.detachedAt)
		d.mu.Unlock()
		switch {
		case connected:
		case busy == 0 && since > idleExit:
			d.shutdown("idle with no gateway")
			return
		case since > orphanTTL:
			d.shutdown("no gateway for " + orphanTTL.String())
			return
		}
	}
}

func (d *daemon) shutdown(why string) {
	d.quitOnce.Do(func() {
		logf("shutting down: %s", why)
		d.ln.Close()
		d.mu.Lock()
		procs := make([]*proc, 0, len(d.procs))
		for _, p := range d.procs {
			procs = append(procs, p)
		}
		if d.linkConn != nil {
			d.linkConn.Close()
		}
		d.mu.Unlock()
		d.resetAll("", why)
		deadline := time.After(killGrace + time.Second)
	wait:
		for _, p := range procs {
			select {
			case <-p.exited:
			case <-deadline:
				break wait
			}
		}
		_ = os.Remove(d.sockPath)
		_ = os.Remove(filepath.Join(filepath.Dir(d.sockPath), "daemon.pid"))
		close(d.quit)
	})
}

// alive reports whether something accepts connections on `sock`.
func alive(sock string) bool {
	c, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

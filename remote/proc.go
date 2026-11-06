package main

import (
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"
	"time"
)

// Agent processes: started on the gateway's `spawn`, fed its `stdin`, and reported back as `out`
// (fd 1, 2 and, for agy's status line, 3), `spawned` and `exit` frames — the same events a local
// child_process gives the gateway, so its runtimes do not need to know which side of ssh a child
// is on.

const (
	pipeChunk = 32 << 10
	killGrace = 2 * time.Second
	// After the process exits, its output pipes are drained for this long. A grandchild that
	// inherited them (a background job) would otherwise hold them open, and the exit would never
	// be reported.
	drainAfterExit = 2 * time.Second
)

// ── one OS thread for every fork ──────────────────────────────────────────────────────────────
// See agentAttr: Pdeathsig is per thread, and Go may run a goroutine's fork on any of them.

type startReq struct {
	cmd  *exec.Cmd
	done chan error
}

var starts = make(chan startReq)

func init() {
	go func() {
		runtime.LockOSThread() // never unlocked: this thread must outlive every child it forks
		for r := range starts {
			r.done <- r.cmd.Start()
		}
	}()
}

func startLocked(cmd *exec.Cmd) error {
	done := make(chan error, 1)
	starts <- startReq{cmd: cmd, done: done}
	return <-done
}

// ── the process ───────────────────────────────────────────────────────────────────────────────

type proc struct {
	d   *daemon
	id  string
	gen uint64

	stdin *pipeWriter

	mu       sync.Mutex
	process  *os.Process
	pending  []syscall.Signal // signals that arrived before the start completed
	finished bool
	exited   chan struct{}
}

var signalNames = map[string]syscall.Signal{
	"SIGHUP": syscall.SIGHUP, "SIGINT": syscall.SIGINT, "SIGQUIT": syscall.SIGQUIT,
	"SIGKILL": syscall.SIGKILL, "SIGTERM": syscall.SIGTERM, "SIGUSR1": syscall.SIGUSR1,
	"SIGUSR2": syscall.SIGUSR2,
}

func signalName(s syscall.Signal) string {
	for n, v := range signalNames {
		if v == s {
			return n
		}
	}
	switch s {
	case syscall.SIGSEGV:
		return "SIGSEGV"
	case syscall.SIGABRT:
		return "SIGABRT"
	case syscall.SIGPIPE:
		return "SIGPIPE"
	case syscall.SIGBUS:
		return "SIGBUS"
	}
	return "SIG" + itoa(uint64(s))
}

// newProc registers the process before it exists, so frames that follow the `spawn` in the stream
// (its first stdin line, a quick `/stop`) have somewhere to go while the start — which may first
// wait for the login environment — is still under way.
func newProc(d *daemon, gen uint64, id string) *proc {
	return &proc{d: d, id: id, gen: gen, stdin: newPipeWriter(), exited: make(chan struct{})}
}

func (p *proc) send(h *Header, body []byte, throttle bool) {
	h.ID = p.id
	p.d.link.send(p.gen, h, body, throttle)
}

func (p *proc) start(h *Header) {
	env := p.d.agentEnv(h.Env, h.Unset)
	cwd := expandHome(h.Cwd)
	if cwd == "" {
		cwd = homeDir()
	}
	path, err := lookPathIn(expandHome(h.Cmd), envGet(env, "PATH"), cwd)
	if err != nil {
		p.fail("spawn " + h.Cmd + ": " + err.Error())
		return
	}
	cmd := &exec.Cmd{Path: path, Args: append([]string{h.Cmd}, h.Args...), Env: env, Dir: cwd, SysProcAttr: agentAttr()}

	// Plain pipes rather than cmd.StdoutPipe: exec.Cmd.Wait would wait for every holder of the
	// pipe, and the exit must be reportable even while a background grandchild still has one.
	var parent, child []*os.File
	pipe := func() (*os.File, *os.File) {
		r, w, perr := os.Pipe()
		if perr != nil {
			err = perr
			return nil, nil
		}
		return r, w
	}
	inR, inW := pipe()
	outR, outW := pipe()
	errR, errW := pipe()
	parent = append(parent, inW, outR, errR)
	child = append(child, inR, outW, errW)
	closeAll := func(fs []*os.File) {
		for _, f := range fs {
			if f != nil {
				f.Close()
			}
		}
	}
	if err != nil {
		closeAll(parent)
		closeAll(child)
		p.fail("spawn " + h.Cmd + ": " + err.Error())
		return
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	err = startLocked(cmd)
	closeAll(child)
	if err != nil {
		closeAll(parent)
		p.fail(err.Error())
		return
	}

	p.mu.Lock()
	p.process = cmd.Process
	pending := p.pending
	p.pending = nil
	p.mu.Unlock()
	p.send(&Header{T: "spawned", Pid: cmd.Process.Pid}, nil, false)
	p.stdin.attach(inW)
	for _, s := range pending {
		_ = cmd.Process.Signal(s)
	}

	var readers sync.WaitGroup
	readFrom := []*os.File{outR, errR}
	for i, f := range readFrom {
		if f == nil {
			continue
		}
		readers.Add(1)
		go p.pump(i+1, f, &readers)
	}
	go p.wait(cmd.Process, &readers, readFrom)
}

func (p *proc) pump(fd int, f *os.File, wg *sync.WaitGroup) {
	defer wg.Done()
	buf := make([]byte, pipeChunk)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			p.send(&Header{T: "out", Fd: fd}, buf[:n], true)
		}
		if err != nil {
			return
		}
	}
}

func (p *proc) wait(pr *os.Process, readers *sync.WaitGroup, files []*os.File) {
	state, err := pr.Wait()
	drained := make(chan struct{})
	go func() { readers.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(drainAfterExit):
		for _, f := range files {
			if f != nil {
				f.Close() // unblocks the readers; what the grandchild writes later goes nowhere
			}
		}
		<-drained
	}
	for _, f := range files {
		if f != nil {
			f.Close()
		}
	}
	p.stdin.end()
	exit := &Header{T: "exit"}
	if err != nil {
		exit.Error = err.Error()
	} else if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		exit.Signal = signalName(ws.Signal())
	} else {
		exit.Code = intPtr(state.ExitCode())
	}
	p.finish(exit)
}

// fail reports a process that never started: an `exit` carrying the reason, as the gateway's local
// spawn would report ENOENT.
func (p *proc) fail(reason string) {
	logf("proc %s: %s", p.id, reason)
	p.stdin.end()
	p.finish(&Header{T: "exit", Error: reason})
}

func (p *proc) finish(exit *Header) {
	p.mu.Lock()
	p.finished = true
	p.mu.Unlock()
	p.d.forgetProc(p)
	p.send(exit, nil, false)
	close(p.exited)
}

func (p *proc) signal(name string) {
	s, ok := signalNames[name]
	if !ok {
		logf("proc %s: ignoring unknown signal %q", p.id, name)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.finished {
		return
	}
	if p.process == nil {
		p.pending = append(p.pending, s)
		return
	}
	_ = p.process.Signal(s)
}

// terminate is the daemon's own stop (a new gateway, a shutdown): SIGTERM, then SIGKILL if the
// process is still there after killGrace — the escalation the gateway uses for local children.
func (p *proc) terminate() {
	p.stdin.end()
	p.signal("SIGTERM")
	go func() {
		select {
		case <-p.exited:
		case <-time.After(killGrace):
			p.signal("SIGKILL")
		}
	}()
}

// ── stdin ─────────────────────────────────────────────────────────────────────────────────────

// pipeWriter feeds a child's stdin from a queue, so a child that is slow to read never blocks the
// connection reader that hands it the bytes. Frames queue from the moment the process is
// registered; writing starts once the pipe exists (attach).
type pipeWriter struct {
	mu    sync.Mutex
	cond  *sync.Cond
	q     [][]byte
	ended bool
	f     *os.File
}

func newPipeWriter() *pipeWriter {
	w := &pipeWriter{}
	w.cond = sync.NewCond(&w.mu)
	return w
}

func (w *pipeWriter) push(b []byte) {
	if len(b) == 0 {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ended {
		return
	}
	w.q = append(w.q, b)
	w.cond.Signal()
}

func (w *pipeWriter) end() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.ended = true
	w.cond.Signal()
}

func (w *pipeWriter) attach(f *os.File) {
	w.mu.Lock()
	w.f = f
	w.mu.Unlock()
	go w.loop()
}

func (w *pipeWriter) loop() {
	defer w.f.Close()
	for {
		w.mu.Lock()
		for len(w.q) == 0 && !w.ended {
			w.cond.Wait()
		}
		if len(w.q) == 0 && w.ended {
			w.mu.Unlock()
			return
		}
		batch := w.q
		w.q = nil
		w.mu.Unlock()
		for _, b := range batch {
			if _, err := w.f.Write(b); err != nil {
				w.mu.Lock()
				w.ended = true
				w.q = nil
				w.mu.Unlock()
				return
			}
		}
	}
}

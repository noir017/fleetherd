package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// `attach` is what the gateway's ssh command runs. It is short-lived and dumb on purpose — it lives
// exactly as long as one ssh connection — and does four things:
//
//  1. checks that it is the binary the gateway meant to run (the gateway passes the hash it
//     uploaded; a mismatch prints TCR-BADSUM and the gateway uploads again);
//  2. makes sure this gateway's daemon is running AT THIS VERSION — stopping a daemon of any other
//     version in the same namespace first, which is how a gateway upgrade retires the old one;
//  3. removes version directories no running daemon uses any more;
//  4. prints TCR-READY and then pipes bytes between ssh and the daemon until either side closes.
//
// Everything before TCR-READY is line-oriented text the gateway scans (an rc file printing a banner
// on a non-interactive shell is not unheard of, so unknown lines are skipped, not fatal); everything
// after it is frames.

const (
	readyLine  = "TCR-READY"
	badSumLine = "TCR-BADSUM"
	errorLine  = "TCR-ERROR"
	// How long attach waits for the daemon lock — another attach for the same gateway (a reconnect
	// racing a slow one) holds it only while it starts or replaces the daemon.
	lockWait = 20 * time.Second
)

func runAttach(args []string) int {
	fs := flag.NewFlagSet("attach", flag.ContinueOnError)
	ns := fs.String("ns", "", "gateway namespace")
	version := fs.String("version", "", "version directory name")
	sum := fs.String("sha256", "", "expected sha256 of this binary")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	fail := func(format string, a ...any) int {
		fmt.Printf("%s %s\n", errorLine, strings.ReplaceAll(fmt.Sprintf(format, a...), "\n", " "))
		return 1
	}
	if !safeName.MatchString(*ns) || !safeName.MatchString(*version) {
		return fail("--ns and --version are required")
	}
	self, err := os.Executable()
	if err != nil {
		return fail("cannot locate this binary: %v", err)
	}
	if *sum != "" {
		got, err := fileSHA256(self)
		if err != nil || got != *sum {
			fmt.Println(badSumLine)
			return 3
		}
	}
	if err := ensureShimLink(*version); err != nil {
		return fail("cannot create the fleetherd shim: %v", err)
	}
	sock, err := ensureDaemon(self, *ns, *version)
	if err != nil {
		return fail("%v", err)
	}
	removeUnusedVersions(*version)

	conn, err := net.Dial("unix", sock)
	if err != nil {
		return fail("cannot reach the daemon: %v", err)
	}
	defer conn.Close()
	fmt.Println(readyLine)
	return pipe(conn)
}

// pipe copies ssh's stdin into the daemon and the daemon's output to ssh's stdout, until either
// direction ends: ssh closing (the gateway went away, or the network did) or the daemon closing
// (a newer connection replaced this one).
func pipe(conn net.Conn) int {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
		if uc, ok := conn.(*net.UnixConn); ok {
			_ = uc.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(os.Stdout, conn)
		done <- struct{}{}
	}()
	<-done
	return 0
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ensureShimLink makes <version>/bin/fleetherd a relative link to the binary beside it — the command
// the bundled skill tells agents to run, and the native-tools server the gateway registers — and
// <version>/bin/talkcode another, the name it had before 3.0.0 (legacy.go).
func ensureShimLink(version string) error {
	bin := binDirFor(version)
	if err := os.MkdirAll(bin, 0o700); err != nil {
		return err
	}
	for _, name := range cliNames {
		link := filepath.Join(bin, name)
		if target, err := os.Readlink(link); err == nil && target == "../fleetherd-remote" {
			continue
		}
		_ = os.Remove(link)
		if err := os.Symlink("../fleetherd-remote", link); err != nil {
			return err
		}
	}
	return nil
}

// ensureDaemon returns the socket of this gateway's daemon at `version`, starting it if needed and
// stopping one of another version first. Serialized per namespace by a lock file, so two attaches
// racing (a reconnect overtaking a slow connection) cannot both start one.
func ensureDaemon(self, ns, version string) (string, error) {
	dir := runDirFor(ns)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	unlock, err := lockFile(filepath.Join(dir, "daemon.lock"), lockWait)
	if err != nil {
		return "", err
	}
	defer unlock()

	sock := sockPathFor(ns)
	if st, err := daemonStatus(sock); err == nil {
		if st.Version == version {
			return sock, nil
		}
		if err := retire(sock, ns, version, st); err != nil {
			return "", err
		}
	}
	if err := spawnDaemon(self, ns, version); err != nil {
		return "", err
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if st, err := daemonStatus(sock); err == nil && st.Version == version {
			return sock, nil
		}
	}
	return "", fmt.Errorf("the daemon did not start; see %s", filepath.Join(dir, "daemon.log"))
}

// retire asks the running daemon of another version to stop — it stops its agents with it — and
// waits for its socket to go away, killing it as a last resort.
func retire(sock, ns, version string, st *Header) error {
	c, err := net.DialTimeout("unix", sock, time.Second)
	if err == nil {
		_ = writeFrame(c, &Header{T: "ctl", Op: "shutdown", Version: version}, nil)
		_, _, _ = readFrame(bufio.NewReader(c))
		c.Close()
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if !alive(sock) {
			return nil
		}
	}
	if st.Pid > 0 && isOurDaemon(st.Pid) {
		_ = syscall.Kill(st.Pid, syscall.SIGKILL)
		time.Sleep(200 * time.Millisecond)
	}
	if alive(sock) {
		return fmt.Errorf("the daemon of version %s in %s would not stop", st.Version, runDirFor(ns))
	}
	_ = os.Remove(sock)
	return nil
}

// isOurDaemon guards the SIGKILL above against a pid that was reused by someone else's process.
func isOurDaemon(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	args := strings.Split(string(b), "\x00")
	// Either name: the daemon an upgrade from 2.x replaces is still talkcode-remote (legacy.go).
	return len(args) > 1 && isRemoteBinary(filepath.Base(args[0])) && args[1] == "daemon"
}

func daemonStatus(sock string) (*Header, error) {
	c, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	if err := writeFrame(c, &Header{T: "ctl", Op: "status"}, nil); err != nil {
		return nil, err
	}
	h, _, err := readFrame(bufio.NewReader(c))
	if err != nil {
		return nil, err
	}
	if h.T != "status" {
		return nil, errors.New("unexpected answer to status: " + h.T)
	}
	return h, nil
}

func spawnDaemon(self, ns, version string) error {
	logPath := filepath.Join(runDirFor(ns), "daemon.log")
	// Keep one previous log: enough to read what happened before a restart, never unbounded.
	if st, err := os.Stat(logPath); err == nil && st.Size() > 4<<20 {
		_ = os.Rename(logPath, logPath+".1")
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return err
	}
	defer devnull.Close()
	cmd := exec.Command(self, "daemon", "--ns", ns, "--version", version)
	cmd.Dir = homeDir()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devnull, logFile, logFile
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// removeUnusedVersions deletes version directories that no running daemon — of any gateway on this
// account — is using. Best-effort: a failure leaves a directory behind, nothing worse.
func removeUnusedVersions(current string) {
	root := rootDir()
	inUse := map[string]bool{current: true}
	if nss, err := os.ReadDir(filepath.Join(root, "run")); err == nil {
		for _, n := range nss {
			if st, err := daemonStatus(sockPathFor(n.Name())); err == nil {
				inUse[st.Version] = true
			}
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || name == "run" || inUse[name] || !safeName.MatchString(name) {
			continue
		}
		// Only what looks like one of ours: a directory holding this program, under either name.
		if !holdsRemoteBinary(filepath.Join(root, name)) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(root, name))
	}
}

func holdsRemoteBinary(dir string) bool {
	for _, name := range []string{"fleetherd-remote", legacyName + "-remote"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

// lockFile takes an exclusive flock, polling until `wait` runs out.
func lockFile(path string, wait time.Duration) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
				f.Close()
			}, nil
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("another connection holds %s", path)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

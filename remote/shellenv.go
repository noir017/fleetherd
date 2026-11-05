package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The environment agents run with: the user's LOGIN environment, not the daemon's.
//
// The daemon inherits what sshd gave a non-interactive command — a bare PATH, and none of what the
// user's shell rc files export. On the reference host that is exactly where the model endpoints and
// API keys live (`~/.bashrc`), and Debian's stock .bashrc returns at its top unless the shell is
// interactive. So the environment is read from an interactive login shell, the way VS Code's remote
// server resolves its "shell environment": run `$SHELL -i -l -c '<this binary> dumpenv'` and parse
// what it prints between two markers (an rc file may print banners of its own; anything outside the
// markers is ignored).
//
// Read again when older than envTTL, so an edited rc file reaches the next agent started after it
// without a restart; held under the lock while reading, so a burst of spawns costs one shell.

const (
	envTTL          = time.Minute
	envCaptureLimit = 10 * time.Second
	envBegin        = "__TALKCODE_REMOTE_ENV_BEGIN__"
	envEnd          = "__TALKCODE_REMOTE_ENV_END__"
)

// Variables that describe the ssh connection or the capturing shell itself, not the user's setup:
// stale the moment the connection that set them is gone, and wrong in an agent's environment.
var envDrop = []string{
	"SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY", "SSH_AUTH_SOCK", "SSH_ORIGINAL_COMMAND",
	"SHLVL", "PWD", "OLDPWD", "_", "PS1", "PROMPT_COMMAND",
	"TALKCODE_REMOTE_SOCK", "TALKCODE_REMOTE_CLI", "TALKCODE_TURN_TOKEN", "TALKCODE_SOCKET",
}

// captureEnv is captureLoginEnv, as a variable so a test can count or replace the capture.
var captureEnv = captureLoginEnv

type shellEnv struct {
	capture func() ([]string, string)

	mu  sync.Mutex
	env []string
	at  time.Time
	how string
}

func (s *shellEnv) get() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.env == nil || time.Since(s.at) > envTTL {
		env, how := s.capture()
		if s.how != how {
			logf("environment for agents: %s (%d variables)", how, len(env))
		}
		s.env, s.at, s.how = env, time.Now(), how
	}
	return append([]string(nil), s.env...)
}

func captureLoginEnv() ([]string, string) {
	self, err := os.Executable()
	if err != nil {
		return cleanEnv(os.Environ()), "the daemon's own (cannot locate this binary: " + err.Error() + ")"
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	script := shellQuote(self) + " dumpenv"
	// Most specific first: an interactive login shell reads everything a terminal session would.
	// Plain `sh` (dash) may refuse -i or -l without a terminal, so each step down drops one.
	for _, flags := range [][]string{{"-i", "-l", "-c"}, {"-l", "-c"}, {"-c"}} {
		args := append(append([]string{}, flags...), script)
		if env, ok := runDumpEnv(shell, args); ok {
			return cleanEnv(env), fmt.Sprintf("%s %s", filepath.Base(shell), strings.Join(flags, " "))
		}
	}
	return cleanEnv(os.Environ()), "the daemon's own (" + filepath.Base(shell) + " did not report one)"
}

func runDumpEnv(shell string, args []string) ([]string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), envCaptureLimit)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Dir = homeDir()
	// A session of its own: no controlling terminal for `-i` to grab, and one group to kill.
	cmd.SysProcAttr = detachAttr()
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := startLocked(cmd); err != nil {
		return nil, false
	}
	_ = cmd.Wait() // an rc file may exit non-zero after the markers were printed; judge by output
	return parseDumpEnv(out.Bytes())
}

func parseDumpEnv(out []byte) ([]string, bool) {
	b := bytes.LastIndex(out, []byte(envBegin))
	if b < 0 {
		return nil, false
	}
	rest := out[b+len(envBegin):]
	e := bytes.Index(rest, []byte(envEnd))
	if e < 0 {
		return nil, false
	}
	var env []string
	if err := json.Unmarshal(rest[:e], &env); err != nil || len(env) == 0 {
		return nil, false
	}
	return env, true
}

func cleanEnv(env []string) []string {
	drop := make(map[string]bool, len(envDrop))
	for _, k := range envDrop {
		drop[k] = true
	}
	out := env[:0:0]
	for _, kv := range env {
		k := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			k = kv[:i]
		}
		if !drop[k] {
			out = append(out, kv)
		}
	}
	return out
}

// runDumpEnvCommand is `talkcode-remote dumpenv`: print this process's environment between the
// markers, for captureLoginEnv to read back.
func runDumpEnvCommand() int {
	b, err := json.Marshal(os.Environ())
	if err != nil {
		return 1
	}
	fmt.Printf("%s%s%s\n", envBegin, b, envEnd)
	return 0
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

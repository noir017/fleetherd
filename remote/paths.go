package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Where things live on the remote host, all under the user's home and all owner-only:
//
//	~/.fleetherd/remote/<version>/fleetherd-remote   this binary, one directory per version
//	~/.fleetherd/remote/<version>/bin/fleetherd      symlink to it: the reverse CLI agents call
//	~/.fleetherd/remote/run/<ns>/daemon.sock        the resident daemon of one gateway
//	~/.fleetherd/remote/run/<ns>/daemon.{pid,lock,log}
//
// <ns> is the gateway's own id, so two gateways reaching the same account (a live one and a test
// one) never share a daemon or each other's agents. <version> is the gateway's package version
// plus the binary's hash, so a rebuild with an unchanged version number is still a new version.

var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$`)

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "/"
}

func rootDir() string              { return filepath.Join(homeDir(), ".fleetherd", "remote") }
func versionDir(v string) string   { return filepath.Join(rootDir(), v) }
func runDirFor(ns string) string   { return filepath.Join(rootDir(), "run", ns) }
func binDirFor(v string) string    { return filepath.Join(versionDir(v), "bin") }
func sockPathFor(ns string) string { return filepath.Join(runDirFor(ns), "daemon.sock") }

// expandHome resolves a leading `~` against this host's home: the gateway names remote paths the
// way an operator would type them, and only this side knows what `~` is here.
func expandHome(p string) string {
	if p == "~" {
		return homeDir()
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(homeDir(), p[2:])
	}
	return p
}

var errNotFound = errors.New("executable file not found in $PATH")

// lookPathIn finds `name` on the CHILD's PATH, not this process's: exec.Command resolves against
// the daemon's own environment, which is the bare one sshd gave it, while the agent is meant to
// run with the user's login environment (shellenv.go) — where `claude-agent-acp` or `agy` usually
// lives under an nvm or ~/.local prefix the bare PATH does not have.
func lookPathIn(name, pathEnv, cwd string) (string, error) {
	if strings.Contains(name, "/") {
		p := name
		if !filepath.IsAbs(p) {
			p = filepath.Join(cwd, p)
		}
		if isExecutable(p) {
			return p, nil
		}
		return "", &os.PathError{Op: "exec", Path: name, Err: errors.New("not an executable file")}
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			dir = "."
		}
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(cwd, dir)
		}
		if p := filepath.Join(dir, name); isExecutable(p) {
			return p, nil
		}
	}
	return "", &os.PathError{Op: "exec", Path: name, Err: errNotFound}
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0
}

func envGet(env []string, key string) string {
	prefix := key + "="
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], prefix) {
			return env[i][len(prefix):]
		}
	}
	return ""
}

// envMerge applies `set` and then `unset` to `base`, last write winning, and returns a fresh slice.
func envMerge(base []string, set map[string]string, unset []string) []string {
	m := make(map[string]string, len(base)+len(set))
	order := make([]string, 0, len(base)+len(set))
	put := func(k, v string) {
		if _, ok := m[k]; !ok {
			order = append(order, k)
		}
		m[k] = v
	}
	for _, kv := range base {
		if i := strings.IndexByte(kv, '='); i > 0 {
			put(kv[:i], kv[i+1:])
		}
	}
	for k, v := range set {
		put(k, v)
	}
	for _, k := range unset {
		delete(m, k)
	}
	out := make([]string, 0, len(m))
	for _, k := range order {
		if v, ok := m[k]; ok {
			out = append(out, k+"="+v)
		}
	}
	return out
}

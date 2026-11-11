package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The 3.0.0 compatibility with the name talkcode (legacy.go). These go with it.

func TestLegacyEnvIsReadWhenTheNewOneIsUnset(t *testing.T) {
	t.Setenv("TALKCODE_TURN_TOKEN", "old")
	if v, ok := getenv("TURN_TOKEN"); !ok || v != "old" {
		t.Fatalf("only the old name set: %q %v", v, ok)
	}
	t.Setenv("FLEETHERD_TURN_TOKEN", "new")
	if v, _ := getenv("TURN_TOKEN"); v != "new" {
		t.Fatalf("both set: %q, want the new name's", v)
	}
	got := withLegacyNames(map[string]string{"FLEETHERD_REMOTE_SOCK": "/s", "PATH": "/p"})
	if got["TALKCODE_REMOTE_SOCK"] != "/s" || got["FLEETHERD_REMOTE_SOCK"] != "/s" || got["PATH"] != "/p" || len(got) != 3 {
		t.Fatalf("withLegacyNames: %v", got)
	}
}

func TestTheShimAnswersToBothNames(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := ensureShimLink("v1"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"fleetherd", "talkcode"} {
		if target, err := os.Readlink(filepath.Join(binDirFor("v1"), name)); err != nil || target != "../fleetherd-remote" {
			t.Fatalf("bin/%s: %q %v", name, target, err)
		}
	}
}

// An agent started by 3.0.0 may still find the Node CLI an older image installed, which knows only
// the TALKCODE_* names.
func TestAgentGetsTheOldNamesToo(t *testing.T) {
	d := testDaemon(t, "legacy-env")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	g.send(&Header{T: "spawn", ID: "p1", Cmd: "sh", Args: []string{"-c", `echo "$TALKCODE_REMOTE_SOCK|$TALKCODE_REMOTE_CLI"`}}, nil)
	_, _, out := g.until("exit", "p1", 5*time.Second)
	if strings.TrimSpace(out) != d.sockPath+"|"+filepath.Join(binDirFor("v1"), "fleetherd") {
		t.Fatalf("old names seen by the agent: %q", out)
	}
}

func TestLoginEnvDropsTheOldNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("TALKCODE_REMOTE_CLI", "/opt/stale/bin/talkcode")
	env, how := captureLoginEnv()
	if envGet(env, "TALKCODE_REMOTE_CLI") != "" {
		t.Fatalf("an inherited TALKCODE_REMOTE_CLI must be dropped (%s)", how)
	}
}

// After the bootstrap's move, ~/.talkcode is a link to ~/.fleetherd, and the links made before it
// still name ~/.talkcode/…: they are ours to repoint, take back and sweep.
func TestLinksIntoTheOldDirectoryAreOurs(t *testing.T) {
	d := testDaemon(t, "legacy-links")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	home := homeDir()
	_ = os.MkdirAll(filepath.Join(home, ".fleetherd", "skills", "foo"), 0o755)
	_ = os.MkdirAll(filepath.Join(home, ".fleetherd", "remote", "v1", "skill"), 0o755)
	if err := os.Symlink(".fleetherd", filepath.Join(home, ".talkcode")); err != nil {
		t.Fatal(err)
	}
	skills := filepath.Join(home, ".claude", "skills")
	_ = os.MkdirAll(skills, 0o755)

	// A managed skill's link, made as ~/.talkcode/skills/foo: repointed under `owned`.
	foo := filepath.Join(skills, "foo")
	_ = os.Symlink(filepath.Join(home, ".talkcode", "skills", "foo"), foo)
	_, res, _ := rpc(t, g, &Header{Op: "ensureLink", Target: "~/.fleetherd/skills/foo", Path: "~/.claude/skills/foo", Requires: "~/.claude", Owned: "~/.fleetherd/skills"}, nil)
	if res["outcome"] != "relinked" {
		t.Fatalf("a link into ~/.talkcode/skills: %v", res)
	}

	// The bundled skill's old link: taken back by removeLink.
	old := filepath.Join(skills, "talkcode")
	_ = os.Symlink(filepath.Join(home, ".talkcode", "remote", "v1", "skill"), old)
	_, res, _ = rpc(t, g, &Header{Op: "removeLink", Path: "~/.claude/skills/talkcode", Owned: "~/.fleetherd/remote"}, nil)
	if res["outcome"] != "removed" {
		t.Fatalf("the old bundled link: %v", res)
	}

	// Still not a licence to touch the operator's: a link elsewhere is kept.
	mine := filepath.Join(skills, "mine")
	_ = os.Symlink(filepath.Join(home, "talkcode-notes", "skills", "mine"), mine)
	_, res, _ = rpc(t, g, &Header{Op: "removeLink", Path: "~/.claude/skills/mine", Owned: "~/.fleetherd/skills"}, nil)
	if res["outcome"] != "kept" {
		t.Fatalf("the operator's link: %v", res)
	}

	// A dead link into an old version directory, spelled the old way: swept.
	dead := filepath.Join(skills, "super")
	_ = os.Symlink(filepath.Join(home, ".talkcode", "remote", "2.60.0-gone", "skill-super"), dead)
	_, res, _ = rpc(t, g, &Header{Op: "sweepSkillLinks", Path: "~/.claude/skills"}, nil)
	removed, _ := res["removed"].([]any)
	if len(removed) != 1 || removed[0] != dead {
		t.Fatalf("swept %v, want only %s", removed, dead)
	}
	if _, err := os.Lstat(dead); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("dead link still there: %v", err)
	}
}

func TestAVersionDirectoryOfTalkcodeRemoteIsRemoved(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for v, bin := range map[string]string{"2.60.0-old": "talkcode-remote", "3.0.0-new": "fleetherd-remote"} {
		_ = os.MkdirAll(versionDir(v), 0o700)
		_ = os.WriteFile(filepath.Join(versionDir(v), bin), nil, 0o700)
	}
	_ = os.MkdirAll(filepath.Join(rootDir(), "not-ours"), 0o700)
	removeUnusedVersions("3.0.0-new")
	if _, err := os.Stat(versionDir("2.60.0-old")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the talkcode-remote version directory is still there: %v", err)
	}
	for _, keep := range []string{versionDir("3.0.0-new"), filepath.Join(rootDir(), "not-ours")} {
		if _, err := os.Stat(keep); err != nil {
			t.Fatalf("removed %s: %v", keep, err)
		}
	}
}

package main

import (
	"os"
	"path/filepath"
	"strings"
)

// What 3.0.0 keeps of the name `talkcode`, which this project carried until then. Everything here
// goes in the next major, and this file with it; nothing else in remote/ spells the old name.
//
//   - The reverse CLI answers to `talkcode` as well as `fleetherd` (a second link in bin/).
//   - Every FLEETHERD_* variable it reads falls back to TALKCODE_*, and the daemon gives agents
//     both names of the two it sets: an image may still carry a Node CLI older than 3.0.0, which
//     reads only TALKCODE_REMOTE_SOCK / TALKCODE_REMOTE_CLI to find the shim.
//   - ~/.talkcode was this directory's name. The gateway's bootstrap moves it to ~/.fleetherd and
//     leaves a ~/.talkcode link (src/remote/connection.ts), so a link made before the move still
//     resolves — but it still reads `~/.talkcode/…`, and the ownership checks below compare paths
//     as written, so they accept the old spelling of each directory too.
//   - A daemon or a version directory left by talkcode-remote is still this program's, to stop
//     and to remove.

const legacyName = "talkcode"

// cliNames are the names under which this binary is the reverse CLI.
var cliNames = []string{"fleetherd", legacyName}

// getenv reads FLEETHERD_<name>, or TALKCODE_<name> when that is unset.
func getenv(name string) (string, bool) {
	if v, ok := os.LookupEnv("FLEETHERD_" + name); ok {
		return v, true
	}
	return os.LookupEnv("TALKCODE_" + name)
}

// withLegacyNames adds the TALKCODE_* twin of every FLEETHERD_* key in vars.
func withLegacyNames(vars map[string]string) map[string]string {
	out := make(map[string]string, 2*len(vars))
	for k, v := range vars {
		out[k] = v
		if rest, ok := strings.CutPrefix(k, "FLEETHERD_"); ok {
			out["TALKCODE_"+rest] = v
		}
	}
	return out
}

// legacyTwin is dir as it was spelled before the rename — ~/.fleetherd/… as ~/.talkcode/… — or ""
// when dir is not under ~/.fleetherd.
func legacyTwin(dir string) string {
	home := homeDir()
	rest, ok := strings.CutPrefix(filepath.Clean(dir), filepath.Join(home, ".fleetherd"))
	if !ok || (rest != "" && !strings.HasPrefix(rest, string(os.PathSeparator))) {
		return ""
	}
	return filepath.Join(home, "."+legacyName) + rest
}

// isRemoteBinary reports whether a file name is this program under its current or its old name.
func isRemoteBinary(name string) bool {
	return name == "fleetherd-remote" || name == legacyName+"-remote"
}

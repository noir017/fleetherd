// fleetherd-remote is the half of fleetherd that runs on a machine whose agents a fleetherd gateway
// drives over ssh. See README.md for what it is, the protocol, and why it is shaped this way.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

// buildVersion is stamped by the build (-ldflags "-X main.buildVersion=…"); informational only —
// which version a host runs is decided by the directory the gateway put it in.
var buildVersion = "dev"

func main() {
	// Invoked through the `fleetherd` link (or `talkcode`, legacy.go): be the reverse CLI.
	if slices.Contains(cliNames, filepath.Base(os.Args[0])) {
		os.Exit(runShim(os.Args[1:]))
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	args := os.Args[2:]
	switch os.Args[1] {
	case "attach":
		os.Exit(runAttach(args))
	case "daemon":
		os.Exit(runDaemon(args))
	case "cli":
		os.Exit(runShim(args))
	case "dumpenv":
		os.Exit(runDumpEnvCommand())
	case "version", "--version":
		fmt.Printf("fleetherd-remote %s (protocol %d)\n", buildVersion, protoVersion)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: fleetherd-remote attach|daemon|cli|dumpenv|version …\n"+
		"Started by a fleetherd gateway over ssh; not meant to be run by hand (except `version`).")
}

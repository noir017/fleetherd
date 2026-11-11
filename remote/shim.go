package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
)

// The `fleetherd` command on a remote host: <version>/bin/fleetherd, a link to this binary, first on
// every agent's PATH.
//
// It does not know a single reverse command. It hands its argv, working directory and turn token to
// the daemon, which forwards them to the gateway; the gateway runs its own `fleetherd` CLI with them
// and streams the output back. So the command table, argument parsing, validation and help text stay
// where they are defined (src/ipc/commands.ts) and cannot drift from a copy here — and the native
// tools server (`fleetherd mcp`, which the gateway registers with ACP harnesses) is the same thing:
// a long-running CLI invocation whose stdin and stdout happen to carry MCP.

func runShim(argv []string) int {
	sock, _ := getenv("REMOTE_SOCK")
	if sock == "" {
		fmt.Fprintln(os.Stderr, "fleetherd: this command works only inside an agent started by fleetherd (FLEETHERD_REMOTE_SOCK is not set)")
		return 1
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetherd: cannot reach the fleetherd-remote daemon at %s: %v\n", sock, err)
		return 1
	}
	defer conn.Close()
	cwd, _ := os.Getwd()
	env := map[string]string{}
	for _, k := range []string{"CWD", "IPC_TIMEOUT_MS"} {
		if v, ok := getenv(k); ok {
			env["FLEETHERD_"+k] = v
		}
	}
	if argv == nil {
		argv = []string{}
	}
	if err := writeFrame(conn, &Header{T: "cli", Argv: argv, Cwd: cwd, Token: token(), Env: env}, nil); err != nil {
		fmt.Fprintf(os.Stderr, "fleetherd: %v\n", err)
		return 1
	}
	go forwardStdin(conn)

	r := bufio.NewReaderSize(conn, 64<<10)
	for {
		h, body, err := readFrame(r)
		if err != nil {
			fmt.Fprintln(os.Stderr, "fleetherd: the connection to the gateway closed before the command finished")
			return 1
		}
		switch h.T {
		case "out":
			if h.Fd == 2 {
				_, _ = os.Stderr.Write(body)
			} else {
				_, _ = os.Stdout.Write(body)
			}
		case "exit":
			if h.Code != nil {
				return *h.Code
			}
			return 0
		}
	}
}

func token() string {
	t, _ := getenv("TURN_TOKEN")
	return t
}

func forwardStdin(conn net.Conn) {
	buf := make([]byte, pipeChunk)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			if writeFrame(conn, &Header{T: "in"}, buf[:n]) != nil {
				return
			}
		}
		if err != nil {
			_ = writeFrame(conn, &Header{T: "in-end"}, nil)
			return
		}
	}
}

//go:build linux

package main

import (
	"syscall"
	"unsafe"
)

// Pdeathsig ties an agent's life to the daemon's: if the daemon dies (a crash, an OOM kill), the
// kernel sends the agent SIGTERM instead of leaving it running unowned with nobody to read its
// output. It fires when the THREAD that forked the child exits, not the process — which is why
// every start goes through startLocked (proc.go), on one OS thread that never exits.
func agentAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}

// groupAttr is for one-shot commands (`run`): their own process group, so a timeout can kill the
// whole tree a shell script started, the same way the gateway's local runner does.
func groupAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
}

// detachAttr is for the daemon itself: a session of its own, so the SIGHUP that sshd sends the
// session of a closing connection does not reach it.
func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func isTerminal(fd uintptr) bool {
	var termios syscall.Termios
	_, _, err := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCGETS, uintptr(unsafe.Pointer(&termios)))
	return err == 0
}

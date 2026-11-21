//go:build !linux

package main

import "syscall"

// Linux is the supported target (see README.md). Elsewhere the program builds — so it can be
// developed on a laptop — without Pdeathsig, which only Linux has.

func agentAttr() *syscall.SysProcAttr  { return &syscall.SysProcAttr{} }
func groupAttr() *syscall.SysProcAttr  { return &syscall.SysProcAttr{Setpgid: true} }
func detachAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }
func isTerminal(_ uintptr) bool        { return false }

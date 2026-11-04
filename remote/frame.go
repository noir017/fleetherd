package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// The wire format every connection in this program speaks — gateway↔daemon through attach, and
// shim↔daemon over the local socket:
//
//	u32 big-endian  header length H
//	u32 big-endian  body length B
//	H bytes         header, a JSON object (Header)
//	B bytes         body, raw bytes (process output, file contents) — never base64'd
//
// The TypeScript side (src/remote/frame.ts) implements the same layout; README.md is the spec and
// src/remote/remote.integration.test.ts drives this binary to keep the two honest.

const (
	maxHeaderBytes = 1 << 20
	maxBodyBytes   = 16 << 20
)

// Header is every field any frame carries. One flat struct rather than a type per message: the
// set is small, both ends are ours, and a flat object is what the TypeScript side reads anyway.
// Zero values are omitted, so a field only appears on the frames that use it.
type Header struct {
	T string `json:"t"`
	// Reliability: S is the sender's sequence number (sequenced frames only), A the highest
	// contiguous sequence the sender has received from its peer (an acknowledgement, on any frame).
	S uint64 `json:"s,omitempty"`
	A uint64 `json:"a,omitempty"`

	// hello / welcome
	Proto    int    `json:"proto,omitempty"`
	Epoch    string `json:"epoch,omitempty"`
	Recv     uint64 `json:"recv,omitempty"`
	Version  string `json:"version,omitempty"`
	Instance string `json:"instance,omitempty"`
	Resumed  bool   `json:"resumed,omitempty"`
	Home     string `json:"home,omitempty"`
	Pid      int    `json:"pid,omitempty"`
	OS       string `json:"os,omitempty"`
	Arch     string `json:"arch,omitempty"`
	N        uint64 `json:"n,omitempty"`

	// processes
	ID     string            `json:"id,omitempty"`
	Cmd    string            `json:"cmd,omitempty"`
	Args   []string          `json:"args,omitempty"`
	Cwd    string            `json:"cwd,omitempty"`
	Env    map[string]string `json:"env,omitempty"`
	Unset  []string          `json:"unset,omitempty"`
	Fd3    bool              `json:"fd3,omitempty"`
	Fd     int               `json:"fd,omitempty"`
	Sig    string            `json:"sig,omitempty"`
	Code   *int              `json:"code,omitempty"`
	Signal string            `json:"signal,omitempty"`
	Error  string            `json:"error,omitempty"`

	// one-shot operations
	Rid       string          `json:"rid,omitempty"`
	Op        string          `json:"op,omitempty"`
	Path      string          `json:"path,omitempty"`
	Max       int64           `json:"max,omitempty"`
	Offset    uint64          `json:"offset,omitempty"`
	Append    bool            `json:"append,omitempty"`
	Grep      []string        `json:"grep,omitempty"`
	Fields    []string        `json:"fields,omitempty"`
	Mode      uint32          `json:"mode,omitempty"`
	Target    string          `json:"target,omitempty"`
	Requires  string          `json:"requires,omitempty"`
	Owned     string          `json:"owned,omitempty"`
	Atomic    bool            `json:"atomic,omitempty"`
	Bash      string          `json:"bash,omitempty"`
	Argv      []string        `json:"argv,omitempty"`
	TimeoutMs int64           `json:"timeoutMs,omitempty"`
	Merge     bool            `json:"merge,omitempty"`
	Res       json.RawMessage `json:"res,omitempty"`

	// reverse commands (the `talkcode` shim)
	Cid   string `json:"cid,omitempty"`
	Token string `json:"token,omitempty"`
}

func intPtr(v int) *int { return &v }

// encodeFrame builds one frame as a single buffer, so a writer can hand it to the connection in
// one Write and two frames can never interleave.
func encodeFrame(h *Header, body []byte) ([]byte, error) {
	hdr, err := json.Marshal(h)
	if err != nil {
		return nil, err
	}
	if len(hdr) > maxHeaderBytes {
		return nil, fmt.Errorf("frame header too large (%d bytes)", len(hdr))
	}
	if len(body) > maxBodyBytes {
		return nil, fmt.Errorf("frame body too large (%d bytes)", len(body))
	}
	buf := make([]byte, 8+len(hdr)+len(body))
	binary.BigEndian.PutUint32(buf[0:4], uint32(len(hdr)))
	binary.BigEndian.PutUint32(buf[4:8], uint32(len(body)))
	copy(buf[8:], hdr)
	copy(buf[8+len(hdr):], body)
	return buf, nil
}

func writeFrame(w io.Writer, h *Header, body []byte) error {
	buf, err := encodeFrame(h, body)
	if err != nil {
		return err
	}
	_, err = w.Write(buf)
	return err
}

var errBadFrame = errors.New("malformed frame")

// readFrame reads one frame. io.EOF only at a clean frame boundary; a stream cut mid-frame is
// io.ErrUnexpectedEOF, which callers treat the same as any other broken connection.
func readFrame(r *bufio.Reader) (*Header, []byte, error) {
	var lens [8]byte
	if _, err := io.ReadFull(r, lens[:]); err != nil {
		return nil, nil, err
	}
	hl := binary.BigEndian.Uint32(lens[0:4])
	bl := binary.BigEndian.Uint32(lens[4:8])
	if hl == 0 || hl > maxHeaderBytes || bl > maxBodyBytes {
		return nil, nil, fmt.Errorf("%w: header %d bytes, body %d bytes", errBadFrame, hl, bl)
	}
	hdr := make([]byte, hl)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return nil, nil, unexpected(err)
	}
	var h Header
	if err := json.Unmarshal(hdr, &h); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", errBadFrame, err)
	}
	var body []byte
	if bl > 0 {
		body = make([]byte, bl)
		if _, err := io.ReadFull(r, body); err != nil {
			return nil, nil, unexpected(err)
		}
	}
	return &h, body, nil
}

func unexpected(err error) error {
	if errors.Is(err, io.EOF) {
		return io.ErrUnexpectedEOF
	}
	return err
}

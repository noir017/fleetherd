package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Relays: a loopback HTTP listener that forwards an agent's API traffic to its real endpoint, for a
// harness whose endpoint an environment variable can redirect (agy's CLOUD_CODE_URL). The gateway
// asks for one (`rpc relay`), points the agent at the URL it gets back, and names the few response
// paths it wants to see. Everything else — the agent's model calls, streamed for as long as it runs —
// is forwarded here, byte for byte, and never touches the link.
//
// Why on this host and not in the gateway: routing the model calls through the gateway would add a
// hop and tie every one of them to the link, which an agent is otherwise allowed to outlive (a
// dropped connection costs it nothing — README "Why it exists"). So only a named path's response
// crosses, and only when it is small and complete: `relay-req` carries it to the gateway, `relay-res`
// brings back what to serve instead. What to change, and why, is the gateway's business (TypeScript);
// this side knows nothing of agy or of any other harness.
//
// It is the one listening TCP socket talkcode-remote opens, and it is held to this: loopback only,
// forwarding only to the upstream the gateway named (https, or http on loopback — a local proxy to
// chain to, or a test), carrying the agent's own requests as they are and adding nothing of its own.

const (
	// A response bigger than this is passed on unchanged rather than held in memory and sent across
	// (a frame body is capped at 16 MiB). agy's model list, the one path asked for today, is ~120 KB.
	relayMaxBody = 8 << 20
)

// How long a response waits for the gateway's answer before it is passed on unchanged. The agent is
// waiting on it meanwhile; an answer normally takes milliseconds, so this only bounds an outage. A
// variable so the tests need not sit through it.
var relayAnswerWait = 15 * time.Second

type relay struct {
	id       string
	gen      uint64
	upstream string
	paths    map[string]bool
	url      string
	srv      *http.Server
}

type relayAnswer struct {
	body []byte
	err  string
}

// relayPathKey marks an outbound request whose response the gateway asked to see, with the path it
// asked by (the outbound URL may carry the upstream's base path in front).
type relayPathKey struct{}

// relayUpstream checks where a relay may forward to.
func relayUpstream(s string) (*url.URL, error) {
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("relay upstream %q is not a plain http(s) URL", s)
	}
	switch u.Scheme {
	case "https":
		return u, nil
	case "http":
		if h := u.Hostname(); h == "localhost" || net.ParseIP(h) != nil && net.ParseIP(h).IsLoopback() {
			return u, nil
		}
		return nil, fmt.Errorf("relay upstream %q: plain http only to a loopback address", s)
	}
	return nil, fmt.Errorf("relay upstream %q: scheme must be https", s)
}

// opRelay answers `rpc relay {id upstream paths}` with `{url}`: the relay under that id, started if it
// is not running or was started with something else. Asking again for the same thing is cheap — the
// gateway does, at every spawn — and returns the same URL, so agents sharing a relay share a listener.
func (d *daemon) opRelay(h *Header) (any, []byte, error) {
	if !safeName.MatchString(h.ID) {
		return nil, nil, fmt.Errorf("relay id %q is not a safe name", h.ID)
	}
	target, err := relayUpstream(h.Upstream)
	if err != nil {
		return nil, nil, err
	}
	paths := map[string]bool{}
	for _, p := range h.Paths {
		if !strings.HasPrefix(p, "/") {
			return nil, nil, fmt.Errorf("relay path %q must start with /", p)
		}
		paths[p] = true
	}
	gen := d.link.currentGen()

	d.mu.Lock()
	defer d.mu.Unlock()
	if r := d.relays[h.ID]; r != nil {
		if r.gen == gen && r.upstream == target.String() && samePaths(r.paths, paths) {
			return map[string]any{"url": r.url}, nil, nil
		}
		delete(d.relays, h.ID)
		go r.close()
	}
	r, err := d.startRelay(h.ID, gen, target, paths)
	if err != nil {
		return nil, nil, err
	}
	d.relays[h.ID] = r
	logf("relay %s: %s → %s (gateway sees %d path(s))", r.id, r.url, r.upstream, len(paths))
	return map[string]any{"url": r.url}, nil, nil
}

func samePaths(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for p := range a {
		if !b[p] {
			return false
		}
	}
	return true
}

func (d *daemon) startRelay(id string, gen uint64, target *url.URL, paths map[string]bool) (*relay, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	r := &relay{id: id, gen: gen, upstream: target.String(), paths: paths, url: "http://" + ln.Addr().String()}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			// SetURL also sets the Host header to the upstream's. No X-Forwarded-* is added: the
			// request goes out as the agent made it.
			pr.SetURL(target)
			if r.paths[pr.In.URL.Path] {
				// Without an Accept-Encoding of the agent's, Go's transport asks for gzip itself and
				// undoes it, so what the gateway is shown is the body, not its compression.
				pr.Out.Header.Del("Accept-Encoding")
				pr.Out = pr.Out.WithContext(context.WithValue(pr.Out.Context(), relayPathKey{}, pr.In.URL.Path))
			}
		},
		// Flush every write: the agent's model calls are server-sent events, and a buffered relay
		// would hold each token back until a buffer filled.
		FlushInterval:  -1,
		ModifyResponse: func(resp *http.Response) error { return d.relayIntercept(r, resp) },
	}
	r.srv = &http.Server{Handler: proxy, ReadHeaderTimeout: 30 * time.Second}
	go func() { _ = r.srv.Serve(ln) }()
	return r, nil
}

func (r *relay) close() { _ = r.srv.Close() }

// relayIntercept hands a named path's response to the gateway and serves what it answers. Anything
// that goes wrong on the way passes the response on as it came: the agent then runs on its own
// settings, which is what it would have done without a relay.
func (d *daemon) relayIntercept(r *relay, resp *http.Response) error {
	path, _ := resp.Request.Context().Value(relayPathKey{}).(string)
	if path == "" || resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Encoding") != "" {
		return nil
	}
	head, err := io.ReadAll(io.LimitReader(resp.Body, relayMaxBody+1))
	if err != nil {
		return err
	}
	if len(head) > relayMaxBody {
		logf("relay %s: %s answered more than %d bytes; passed on unchanged", r.id, path, relayMaxBody)
		resp.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(head), resp.Body), resp.Body}
		return nil
	}
	_ = resp.Body.Close()
	body := head
	if out, ok := d.askGateway(r, path, head); ok {
		body = out
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.TransferEncoding = nil
	return nil
}

// askGateway sends one response to the gateway and waits for its answer: a body to serve instead, or
// nothing (empty body, or an error) to serve the original. The frame is sequenced, so during an
// outage it waits in the link like any other; the wait here is what bounds it.
func (d *daemon) askGateway(r *relay, path string, body []byte) ([]byte, bool) {
	ch := make(chan relayAnswer, 1)
	d.mu.Lock()
	d.nextXid++
	xid := "x" + itoa(d.nextXid)
	d.relayWaits[xid] = ch
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.relayWaits, xid)
		d.mu.Unlock()
	}()
	if !d.link.send(r.gen, &Header{T: "relay-req", ID: r.id, Xid: xid, Path: path}, body, false) {
		return nil, false
	}
	t := time.NewTimer(relayAnswerWait)
	defer t.Stop()
	select {
	case a := <-ch:
		if a.err != "" {
			logf("relay %s: the gateway could not handle %s (%s); passed on unchanged", r.id, path, a.err)
			return nil, false
		}
		return a.body, len(a.body) > 0
	case <-t.C:
		logf("relay %s: no answer from the gateway about %s within %v; passed on unchanged", r.id, path, relayAnswerWait)
		return nil, false
	}
}

// answerRelay delivers a `relay-res` to the response waiting for it; a late one finds nobody.
func (d *daemon) answerRelay(h *Header, body []byte) {
	d.mu.Lock()
	ch := d.relayWaits[h.Xid]
	d.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- relayAnswer{body: body, err: h.Error}:
	default:
	}
}

// closeRelays stops every relay; called with everything else a gateway started (resetAll).
func (d *daemon) closeRelays() {
	d.mu.Lock()
	relays := d.relays
	d.relays = map[string]*relay{}
	d.mu.Unlock()
	for _, r := range relays {
		r.close()
	}
}

package main

import (
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A stand-in for the agent's API: one streamed path, one JSON path (gzipped when the client allows
// it, as Google's front end does), and an echo of what arrived.
func fakeUpstream(t *testing.T, release <-chan struct{}) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1internal:streamGenerateContent":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: one\n\n")
			w.(http.Flusher).Flush()
			<-release // the second event only once the test has seen the first through the relay
			fmt.Fprint(w, "data: two\n\n")
		case "/v1internal:fetchAvailableModels":
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				w.Header().Set("Content-Encoding", "gzip")
				zw := gzip.NewWriter(w)
				fmt.Fprint(zw, `{"limit":"256000"}`)
				_ = zw.Close()
				return
			}
			fmt.Fprint(w, `{"limit":"256000"}`)
		default:
			fmt.Fprintf(w, "%s %s?%s host=%s auth=%s", r.Method, r.URL.Path, r.URL.RawQuery, r.Host, r.Header.Get("Authorization"))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func openRelay(t *testing.T, g *gateway, id, upstream string, paths ...string) string {
	t.Helper()
	r, res, _ := rpc(t, g, &Header{Op: "relay", ID: id, Upstream: upstream, Paths: paths}, nil)
	if r.T != "rpc-ok" {
		t.Fatalf("relay: %+v", r)
	}
	url, _ := res["url"].(string)
	if !strings.HasPrefix(url, "http://127.0.0.1:") {
		t.Fatalf("relay url %q", url)
	}
	return url
}

func get(t *testing.T, url string) string {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.ContentLength >= 0 && int(resp.ContentLength) != len(b) {
		t.Fatalf("Content-Length %d for a %d-byte body", resp.ContentLength, len(b))
	}
	return string(b)
}

func TestRelayForwardsAndStreams(t *testing.T) {
	release := make(chan struct{})
	up := fakeUpstream(t, release)
	d := testDaemon(t, "relay1")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	url := openRelay(t, g, "agy.t1", up.URL, "/v1internal:fetchAvailableModels")

	req, _ := http.NewRequest("POST", url+"/v1internal:loadCodeAssist?x=1", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	want := "POST /v1internal:loadCodeAssist?x=1 host=" + strings.TrimPrefix(up.URL, "http://") + " auth=Bearer tok"
	if string(b) != want {
		t.Fatalf("forwarded as %q, want %q", b, want)
	}

	// Streamed: the first event arrives while the upstream is still holding the second.
	resp, err = http.Get(url + "/v1internal:streamGenerateContent?alt=sse")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	br := bufio.NewReader(resp.Body)
	line, err := br.ReadString('\n')
	if err != nil || line != "data: one\n" {
		t.Fatalf("first event %q %v", line, err)
	}
	close(release)
	rest, _ := io.ReadAll(br)
	if !strings.Contains(string(rest), "data: two") {
		t.Fatalf("rest of the stream %q", rest)
	}
}

func TestRelayHandsANamedPathToTheGateway(t *testing.T) {
	up := fakeUpstream(t, nil)
	d := testDaemon(t, "relay2")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	url := openRelay(t, g, "agy.t2", up.URL, "/v1internal:fetchAvailableModels")

	got := make(chan string, 1)
	go func() { got <- get(t, url+"/v1internal:fetchAvailableModels") }()
	h, body, _ := g.until("relay-req", "agy.t2", 5*time.Second)
	if h.Path != "/v1internal:fetchAvailableModels" || string(body) != `{"limit":"256000"}` {
		t.Fatalf("relay-req %+v body %q (the gateway must see the body uncompressed)", h, body)
	}
	g.send(&Header{T: "relay-res", Xid: h.Xid}, []byte(`{"limit":"900000"}`))
	if s := <-got; s != `{"limit":"900000"}` {
		t.Fatalf("served %q", s)
	}

	// Declined (empty answer) and failed (an error): the original, unchanged.
	for _, answer := range []*Header{{T: "relay-res"}, {T: "relay-res", Error: "boom"}} {
		go func() { got <- get(t, url+"/v1internal:fetchAvailableModels") }()
		h, _, _ := g.until("relay-req", "agy.t2", 5*time.Second)
		answer.Xid = h.Xid
		g.send(answer, nil)
		if s := <-got; s != `{"limit":"256000"}` {
			t.Fatalf("after %+v served %q", answer, s)
		}
	}
}

func TestRelayPassesOnUnchangedWhenTheGatewayIsSilent(t *testing.T) {
	prev := relayAnswerWait
	relayAnswerWait = 200 * time.Millisecond
	t.Cleanup(func() { relayAnswerWait = prev })
	up := fakeUpstream(t, nil)
	d := testDaemon(t, "relay3")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	url := openRelay(t, g, "agy.t3", up.URL, "/v1internal:fetchAvailableModels")
	if s := get(t, url+"/v1internal:fetchAvailableModels"); s != `{"limit":"256000"}` {
		t.Fatalf("served %q", s)
	}
}

func TestRelayIsReusedAndReplaced(t *testing.T) {
	up := fakeUpstream(t, nil)
	d := testDaemon(t, "relay4")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	a := openRelay(t, g, "agy.t4", up.URL, "/a")
	if b := openRelay(t, g, "agy.t4", up.URL, "/a"); b != a {
		t.Fatalf("same spec, new listener: %s then %s", a, b)
	}
	c := openRelay(t, g, "agy.t4", up.URL, "/a", "/b")
	if c == a {
		t.Fatal("a changed spec kept the old listener")
	}
	for _, bad := range []string{"http://example.com", "ftp://127.0.0.1", "https://u:p@example.com", "not a url"} {
		r, _, _ := rpc(t, g, &Header{Op: "relay", ID: "agy.bad", Upstream: bad}, nil)
		if r.T != "rpc-err" {
			t.Fatalf("upstream %q accepted", bad)
		}
	}
}

func TestANewGatewayClosesTheOldOnesRelays(t *testing.T) {
	up := fakeUpstream(t, nil)
	d := testDaemon(t, "relay5")
	g := dialGateway(t, d.sockPath, "E1", 0, 0)
	url := openRelay(t, g, "agy.t5", up.URL)
	g.conn.Close()
	dialGateway(t, d.sockPath, "E2", 0, 0)
	if _, err := http.Get(url + "/x"); err == nil {
		t.Fatal("the old gateway's relay still answers")
	}
}

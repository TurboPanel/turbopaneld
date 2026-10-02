// Differential harness for the Docker gate's request parser.
//
// The Docker engine serves its API with Go's net/http, so net/http.ReadRequest
// plus Request.ParseForm is the parser whose reading of a request the gate must
// match. This program (standard library only) reads a corpus of raw requests
// (testdata/parser-cases.json: {name, raw}, raw one JSON string whose code
// points are bytes 0-255) and prints, per case, what Go made of it. The Deno
// test src/docker-gate/parser-differential.test.ts compares that with the
// gate's parser; testdata/go-parser.json is this program's recorded output.
//
// Usage: go run main.go ../../docker-gate/testdata/parser-cases.json
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
)

type input struct {
	Name string `json:"name"`
	Raw  string `json:"raw"`
}

type result struct {
	Name     string              `json:"name"`
	OK       bool                `json:"ok"`
	Error    string              `json:"error,omitempty"`
	Method   string              `json:"method,omitempty"`
	Path     string              `json:"path,omitempty"`
	BodyLen  int                 `json:"bodyLen"`
	Chunked  bool                `json:"chunked"`
	Leftover int                 `json:"leftover"`
	Form     map[string][]string `json:"form"`
	FormErr  bool                `json:"formErr"`
}

// serverChecks are the checks net/http's server makes after ReadRequest.
func serverChecks(req *http.Request) string {
	// ReadRequest moves Host out of Header into req.Host (repeats already fail).
	if req.ProtoAtLeast(1, 1) && req.Method != "CONNECT" && req.Host == "" {
		return "missing Host"
	}
	return ""
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

func run(in input) result {
	raw := make([]byte, 0, len(in.Raw))
	for _, r := range in.Raw {
		raw = append(raw, byte(r))
	}
	out := result{Name: in.Name, Form: map[string][]string{}}
	reader := bufio.NewReader(bytes.NewReader(raw))
	req, err := http.ReadRequest(reader)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	if msg := serverChecks(req); msg != "" {
		out.Error = msg
		return out
	}
	out.OK = true
	out.Method = req.Method
	out.Path = req.URL.Path
	out.Chunked = len(req.TransferEncoding) > 0 && req.TransferEncoding[0] == "chunked"
	// ParseForm reads the body itself for urlencoded POST/PUT/PATCH, as the
	// engine's handlers do, so count the payload bytes as they are read.
	counter := &countingReader{r: req.Body}
	req.Body = io.NopCloser(counter)
	if err := req.ParseForm(); err != nil {
		out.FormErr = true
	}
	for k, v := range req.Form {
		out.Form[k] = v
	}
	_, _ = io.Copy(io.Discard, req.Body)
	out.BodyLen = counter.n
	left, _ := io.ReadAll(reader)
	out.Leftover = len(left)
	return out
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run main.go cases.json")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var cases []input
	if err := json.Unmarshal(data, &cases); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	results := make([]result, 0, len(cases))
	for _, c := range cases {
		results = append(results, run(c))
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(map[string]any{"go": runtime.Version(), "results": results}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

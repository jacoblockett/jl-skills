package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

func agentPaths(agent string, s scope) (string, string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	switch agent {
	case "codex":
		if s.Kind == "user" {
			return filepath.Join(home, ".agents", "skills"), filepath.Join(home, ".codex", "AGENTS.md"), nil
		}
		return filepath.Join(s.Root, ".agents", "skills"), filepath.Join(s.Root, "AGENTS.md"), nil
	case "claude":
		if s.Kind == "user" {
			return filepath.Join(home, ".claude", "skills"), filepath.Join(home, ".claude", "CLAUDE.md"), nil
		}
		return filepath.Join(s.Root, ".claude", "skills"), filepath.Join(s.Root, "CLAUDE.md"), nil
	default:
		return "", "", fmt.Errorf("unsupported agent %q", agent)
	}
}

func detectedAgents() []string {
	var out []string
	for _, spec := range agentCatalog {
		if harnessDetected(spec.Command, spec.Marker) {
			out = append(out, spec.ID)
		}
	}
	sort.Strings(out)
	return out
}

func harnessDetected(command, marker string) bool {
	if _, err := exec.LookPath(command); err == nil {
		return true
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	st, err := os.Stat(filepath.Join(home, marker))
	return err == nil && st.IsDir()
}

func resolveScope(raw string) (scope, error) {
	raw = strings.TrimSpace(raw)
	if raw == "user" {
		home, err := os.UserHomeDir()
		if err != nil {
			return scope{}, err
		}
		home, err = canonicalPath(home)
		return scope{Kind: "user", Identity: "user", Root: home}, err
	}
	if raw == "cwd" {
		cwd, err := os.Getwd()
		if err != nil {
			return scope{}, err
		}
		p, err := canonicalPath(cwd)
		return scope{Kind: "project", Identity: p, Root: p}, err
	}
	if raw == "" {
		return scope{}, errors.New("empty scope")
	}
	p, err := canonicalPath(expandPath(raw))
	if err != nil {
		return scope{}, err
	}
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return scope{}, fmt.Errorf("scope path is not a directory: %s", p)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return scope{}, err
	}
	return scope{Kind: "project", Identity: p, Root: p}, nil
}

func expandPath(p string) string {
	p = os.ExpandEnv(p)
	if runtime.GOOS == "windows" {
		p = expandPercentVars(p)
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			if p == "~" {
				p = home
			} else {
				p = filepath.Join(home, p[2:])
			}
		}
	}
	return p
}

func expandPercentVars(s string) string {
	for {
		a := strings.IndexByte(s, '%')
		if a < 0 {
			return s
		}
		r := strings.IndexByte(s[a+1:], '%')
		if r < 0 {
			return s
		}
		b := a + 1 + r
		name := s[a+1 : b]
		val, ok := os.LookupEnv(name)
		if !ok {
			return s
		}
		s = s[:a] + val + s[b+1:]
	}
}

func canonicalPath(p string) (string, error) {
	if !filepath.IsAbs(p) {
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		p = filepath.Join(cwd, p)
	}
	p, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return "", err
	}
	if x, err := filepath.EvalSymlinks(p); err == nil {
		p = x
	}
	return filepath.Clean(p), nil
}

func registryPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".jl-skill", "registry.json"), nil
}

func loadRegistry() (registry, error) {
	var r registry
	path, err := registryPath()
	if err != nil {
		return r, err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return r, fmt.Errorf("read registry: %w", err)
	}
	return r, nil
}

func saveReceipt(rec receipt) error {
	r, err := loadRegistry()
	if err != nil {
		return err
	}
	kept := r.Installations[:0]
	for _, old := range r.Installations {
		if old.Skill == rec.Skill && old.Scope.Identity == rec.Scope.Identity && old.Agent == rec.Agent {
			continue
		}
		kept = append(kept, old)
	}
	r.Installations = append(kept, rec)
	path, err := registryPath()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return atomicWrite(path, b, 0o644)
}

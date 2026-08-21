package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

//go:embed skills/**
var catalog embed.FS

const version = "0.1.0-dev"

type manifest struct {
	Name                string   `json:"name"`
	Version             string   `json:"version"`
	Description         string   `json:"description"`
	SkillFiles          []string `json:"skill_files"`
	RuntimeFiles        []string `json:"runtime_files"`
	Runtime             string   `json:"runtime"`
	RuntimeDependencies []string `json:"runtime_dependencies"`
	InstructionFragment string   `json:"instruction_fragment"`
	ProjectInit         []string `json:"project_init"`
}

type scope struct {
	Kind     string `json:"kind"`
	Identity string `json:"identity"`
	Root     string `json:"root"`
}

type receipt struct {
	Skill       string    `json:"skill"`
	Version     string    `json:"version"`
	Scope       scope     `json:"scope"`
	Agent       string    `json:"agent"`
	SkillPath   string    `json:"skill_path"`
	RuntimeRoot string    `json:"runtime_root"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type registry struct {
	Installations []receipt `json:"installations"`
}

type pyExec struct {
	Exe    string
	Prefix []string
}

type repeatedFlag []string

func (r *repeatedFlag) String() string { return strings.Join(*r, ",") }
func (r *repeatedFlag) Set(v string) error {
	*r = append(*r, v)
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "jl-skill:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Println(version)
		return nil
	}
	if len(args) > 0 && args[0] == "update" {
		return runUpdate(args[1:])
	}
	return runInstall(args)
}

func runInstall(args []string) error {
	var skills []string
	var scopeRaw string
	var agents repeatedFlag
	interactive := isInteractive()

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "--scope":
			if i+1 >= len(args) {
				return errors.New("--scope requires user, cwd, or a path")
			}
			i++
			scopeRaw = args[i]
		case "--agent":
			if i+1 >= len(args) {
				return errors.New("--agent requires a harness name")
			}
			i++
			agents = append(agents, args[i])
		case "--help", "-h":
			printHelp()
			return nil
		default:
			if strings.HasPrefix(a, "-") {
				return fmt.Errorf("unknown option %s", a)
			}
			skills = append(skills, a)
		}
	}

	if len(skills) == 0 {
		if !interactive {
			return errors.New("no skills selected")
		}
		chosen, err := ask("Skills to install (comma separated)")
		if err != nil {
			return err
		}
		skills = splitCSV(chosen)
		if len(skills) == 0 {
			return errors.New("no skills selected")
		}
	}

	if scopeRaw == "" {
		if !interactive {
			return errors.New("--scope is required in non-interactive mode")
		}
		chosen, err := ask("Scope (user, cwd, or path)")
		if err != nil {
			return err
		}
		scopeRaw = chosen
	}

	s, err := resolveScope(scopeRaw)
	if err != nil {
		return err
	}

	resolvedAgents, err := chooseAgents(agents, interactive)
	if err != nil {
		return err
	}

	fmt.Printf("Scope: %s\n", s.Identity)
	fmt.Printf("Agents: %s\n", strings.Join(resolvedAgents, ", "))
	fmt.Printf("Skills: %s\n", strings.Join(skills, ", "))

	for _, name := range skills {
		m, err := loadManifest(name)
		if err != nil {
			return err
		}
		if err := installOne(m, s, resolvedAgents); err != nil {
			return err
		}
	}
	return nil
}

func runUpdate(args []string) error {
	var names []string
	var scopeRaw string
	var agents repeatedFlag
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--scope":
			if i+1 >= len(args) {
				return errors.New("--scope requires user, cwd, or a path")
			}
			i++
			scopeRaw = args[i]
		case "--agent":
			if i+1 >= len(args) {
				return errors.New("--agent requires a harness name")
			}
			i++
			agents = append(agents, args[i])
		case "--help", "-h":
			printUpdateHelp()
			return nil
		default:
			if strings.HasPrefix(args[i], "-") {
				return fmt.Errorf("unknown update option %s", args[i])
			}
			names = append(names, args[i])
		}
	}

	r, err := loadRegistry()
	if err != nil {
		return err
	}
	nameFilter := stringSet(names)
	agentFilter, err := normalizeAgents(agents)
	if err != nil {
		return err
	}
	agentSet := stringSet(agentFilter)
	var scopeFilter *scope
	if scopeRaw != "" {
		s, err := resolveScope(scopeRaw)
		if err != nil {
			return err
		}
		scopeFilter = &s
	}

	type group struct {
		M      manifest
		S      scope
		Agents []string
	}
	groups := map[string]*group{}
	for _, rec := range r.Installations {
		if len(nameFilter) > 0 && !nameFilter[rec.Skill] {
			continue
		}
		if len(agentSet) > 0 && !agentSet[rec.Agent] {
			continue
		}
		if scopeFilter != nil && rec.Scope.Identity != scopeFilter.Identity {
			continue
		}
		m, err := loadManifest(rec.Skill)
		if err != nil {
			return err
		}
		key := rec.Skill + "\x00" + rec.Scope.Kind + "\x00" + rec.Scope.Identity
		g := groups[key]
		if g == nil {
			g = &group{M: m, S: rec.Scope}
			groups[key] = g
		}
		g.Agents = append(g.Agents, rec.Agent)
	}
	if len(groups) == 0 {
		return errors.New("no installations match update filters")
	}
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		g := groups[k]
		agents, err := normalizeAgents(g.Agents)
		if err != nil {
			return err
		}
		fmt.Printf("Updating %s at %s for %s\n", g.M.Name, g.S.Identity, strings.Join(agents, ", "))
		if err := installOne(g.M, g.S, agents); err != nil {
			return err
		}
	}
	return nil
}

func loadManifest(name string) (manifest, error) {
	var m manifest
	b, err := catalog.ReadFile("skills/" + name + "/jl-skill.json")
	if err != nil {
		return m, fmt.Errorf("unknown skill %q", name)
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("parse %s manifest: %w", name, err)
	}
	if m.Name == "" || m.Version == "" || len(m.SkillFiles) == 0 {
		return m, fmt.Errorf("invalid manifest for %s", name)
	}
	return m, nil
}

func installOne(m manifest, s scope, agents []string) error {
	if s.Kind == "project" {
		if err := os.MkdirAll(s.Root, 0o755); err != nil {
			return err
		}
	}
	dataRoot := filepath.Join(s.Root, ".jl-skill")
	packageRoot := filepath.Join(dataRoot, "packages", m.Name)
	runtimeRoot := filepath.Join(dataRoot, "runtime", m.Name)

	for _, rel := range m.RuntimeFiles {
		if err := extractAsset(m.Name, rel, filepath.Join(packageRoot, rel), nil); err != nil {
			return err
		}
	}
	cli, err := provisionRuntime(m, packageRoot, runtimeRoot)
	if err != nil {
		return err
	}
	tokens := map[string]string{"{{JL_MAP_CLI}}": filepath.Clean(cli)}

	fragment := ""
	if m.InstructionFragment != "" {
		b, err := catalog.ReadFile("skills/" + m.Name + "/" + m.InstructionFragment)
		if err != nil {
			return err
		}
		fragment = render(string(b), tokens)
	}

	for _, agent := range agents {
		skillRoot, instruction, err := agentPaths(agent, s)
		if err != nil {
			return err
		}
		dest := filepath.Join(skillRoot, m.Name)
		for _, rel := range m.SkillFiles {
			if err := extractAsset(m.Name, rel, filepath.Join(dest, rel), tokens); err != nil {
				return err
			}
		}
		if fragment != "" {
			if err := managedBlock(instruction, m.Name, fragment); err != nil {
				return err
			}
		}
		if err := saveReceipt(receipt{Skill: m.Name, Version: m.Version, Scope: s, Agent: agent, SkillPath: dest, RuntimeRoot: runtimeRoot, UpdatedAt: time.Now().UTC()}); err != nil {
			return err
		}
		fmt.Printf("Installed %s %s for %s at %s\n", m.Name, m.Version, agent, dest)
	}

	if s.Kind == "project" && len(m.ProjectInit) > 0 {
		if m.ProjectInit[0] != "map-state" {
			return fmt.Errorf("unsupported project initializer %q", m.ProjectInit[0])
		}
		args := append([]string{"--root", s.Root}, m.ProjectInit[1:]...)
		cmd := exec.Command(cli, args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s project init: %w", m.Name, err)
		}
	}
	return nil
}

func provisionRuntime(m manifest, packageRoot, runtimeRoot string) (string, error) {
	if m.Runtime != "python" {
		return "", fmt.Errorf("unsupported runtime %q", m.Runtime)
	}
	host, err := findPython311()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(runtimeRoot, 0o755); err != nil {
		return "", err
	}

	// The first prototype used pip --target with the host interpreter. That kept
	// files project-local, but the resulting process could still see host
	// site-packages and therefore was not dependency-isolated. A real venv makes
	// the runtime both filesystem-local and import-isolated.
	venvRoot := filepath.Join(runtimeRoot, "venv")
	venvPy := venvPython(venvRoot)
	if _, err := os.Stat(venvPy); errors.Is(err, os.ErrNotExist) {
		args := append([]string{}, host.Prefix...)
		args = append(args, "-m", "venv", venvRoot)
		cmd := exec.Command(host.Exe, args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("create isolated %s runtime: %w", m.Name, err)
		}
	} else if err != nil {
		return "", err
	}

	if len(m.RuntimeDependencies) > 0 {
		args := []string{"-m", "pip", "install", "--disable-pip-version-check", "--upgrade"}
		args = append(args, m.RuntimeDependencies...)
		cmd := exec.Command(venvPy, args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("install isolated runtime dependencies: %w", err)
		}
	}

	// Remove the dependency directory created by the legacy --target prototype.
	// It is installer-owned and no longer participates in execution.
	legacyDeps := filepath.Join(runtimeRoot, "site-packages")
	if err := os.RemoveAll(legacyDeps); err != nil {
		return "", fmt.Errorf("remove legacy runtime dependencies: %w", err)
	}

	runner := filepath.Join(runtimeRoot, "runner.py")
	runnerBody := fmt.Sprintf("import sys\nsys.path.insert(0, %q)\nfrom map_entry import main\nraise SystemExit(main())\n", packageRoot)
	if err := atomicWrite(runner, []byte(runnerBody), 0o644); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		cli := filepath.Join(runtimeRoot, "map-state.cmd")
		body := "@echo off\r\n" + cmdArg(venvPy) + " " + cmdArg(runner) + " %*\r\n"
		return cli, atomicWrite(cli, []byte(body), 0o755)
	}
	cli := filepath.Join(runtimeRoot, "map-state")
	body := "#!/bin/sh\nexec " + shArg(venvPy) + " " + shArg(runner) + ` "$@"` + "\n"
	return cli, atomicWrite(cli, []byte(body), 0o755)
}

func venvPython(venvRoot string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(venvRoot, "Scripts", "python.exe")
	}
	return filepath.Join(venvRoot, "bin", "python")
}

func findPython311() (pyExec, error) {
	candidates := []pyExec{{Exe: "python3"}, {Exe: "python"}}
	if runtime.GOOS == "windows" {
		candidates = []pyExec{{Exe: "python"}, {Exe: "py", Prefix: []string{"-3"}}, {Exe: "python3"}}
	}
	for _, c := range candidates {
		path, err := exec.LookPath(c.Exe)
		if err != nil {
			continue
		}
		args := append([]string{}, c.Prefix...)
		args = append(args, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)")
		if exec.Command(path, args...).Run() == nil {
			c.Exe = path
			return c, nil
		}
	}
	return pyExec{}, errors.New("Map currently requires Python 3.11+; no compatible interpreter was found")
}

func extractAsset(skill, rel, dest string, tokens map[string]string) error {
	b, err := catalog.ReadFile("skills/" + skill + "/" + filepath.ToSlash(rel))
	if err != nil {
		return err
	}
	if tokens != nil {
		b = []byte(render(string(b), tokens))
	}
	return atomicWrite(dest, b, 0o644)
}

func render(s string, tokens map[string]string) string {
	for from, to := range tokens {
		s = strings.ReplaceAll(s, from, to)
	}
	return s
}

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
	if harnessDetected("codex", ".codex") {
		out = append(out, "codex")
	}
	if harnessDetected("claude", ".claude") {
		out = append(out, "claude")
	}
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
func normalizeAgents(raw []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, item := range raw {
		a := strings.ToLower(strings.TrimSpace(item))
		if a == "claude-code" {
			a = "claude"
		}
		if a != "codex" && a != "claude" {
			return nil, fmt.Errorf("unsupported agent %q", item)
		}
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	sort.Strings(out)
	return out, nil
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

func managedBlock(path, skill, fragment string) error {
	begin, end := "<!-- jl-skill:begin "+skill+" -->", "<!-- jl-skill:end "+skill+" -->"
	block := begin + "\n" + strings.TrimSpace(fragment) + "\n" + end
	var current string
	if b, err := os.ReadFile(path); err == nil {
		current = string(b)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	bi, ei := strings.Index(current, begin), strings.Index(current, end)
	if (bi >= 0) != (ei >= 0) {
		return fmt.Errorf("malformed jl-skill block in %s", path)
	}
	if bi >= 0 {
		if strings.Count(current, begin) != 1 || strings.Count(current, end) != 1 || ei < bi {
			return fmt.Errorf("ambiguous jl-skill block in %s", path)
		}
		current = current[:bi] + block + current[ei+len(end):]
	} else if strings.TrimSpace(current) == "" {
		current = block + "\n"
	} else {
		current = strings.TrimRight(current, "\r\n") + "\n\n" + block + "\n"
	}
	return atomicWrite(path, []byte(current), 0o644)
}

func atomicWrite(path string, data []byte, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".jl-skill-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		_ = os.Remove(path)
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return nil
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

func chooseAgents(explicit []string, interactive bool) ([]string, error) {
	if len(explicit) > 0 {
		return normalizeAgents(explicit)
	}
	detected := detectedAgents()
	if len(detected) == 0 {
		if !interactive {
			return nil, errors.New("no supported AI harness detected; use --agent explicitly")
		}
		chosen, err := ask("No supported harness detected. Agents to target (codex, claude)")
		if err != nil {
			return nil, err
		}
		return normalizeAgents(splitCSV(chosen))
	}
	if !interactive {
		return detected, nil
	}
	chosen, err := askDefault("Detected agents", strings.Join(detected, ","))
	if err != nil {
		return nil, err
	}
	return normalizeAgents(splitCSV(chosen))
}

func printHelp() {
	fmt.Println(`jl-skill - install agent skills

Usage:
  jl-skill [skills...] --scope user|cwd|PATH [--agent AGENT]...
  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...

If --agent is omitted, all detected supported harnesses are selected.
If arguments are omitted on an interactive terminal, jl-skill prompts for them.`)
}
func printUpdateHelp() {
	fmt.Println(`jl-skill update - update installer-managed skill installations

Usage:
  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...`)
}

func isInteractive() bool {
	st, err := os.Stdin.Stat()
	return err == nil && (st.Mode()&os.ModeCharDevice) != 0
}

func splitCSV(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
func stringSet(items []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range items {
		m[strings.ToLower(strings.TrimSpace(x))] = true
	}
	return m
}

func cmdArg(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func shArg(s string) string  { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

var stdin = bufio.NewReader(os.Stdin)

func ask(label string) (string, error) {
	fmt.Print("? " + label + ": ")
	line, err := stdin.ReadString('\n')
	if err != nil && !errors.Is(err, os.ErrClosed) {
		return "", err
	}
	return strings.TrimSpace(line), nil
}
func askDefault(label, def string) (string, error) {
	fmt.Printf("? %s [%s]: ", label, def)
	line, err := stdin.ReadString('\n')
	if err != nil && !errors.Is(err, os.ErrClosed) {
		return "", err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return def, nil
	}
	return line, nil
}

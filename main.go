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

//go:embed all:skills
var catalog embed.FS

const version = "0.1.0-dev"

type manifest struct {
	Name                string   `json:"name"`
	Version             string   `json:"version"`
	Description         string   `json:"description"`
	SkillFiles          []string `json:"skill_files"`
	RuntimeFiles        []string `json:"runtime_files"`
	RuntimeDependencies []string `json:"runtime_dependencies"`
	InstructionFragment string   `json:"instruction_fragment"`
	Runtime             string   `json:"runtime"`
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

type opts struct {
	Command string
	Skills  []string
	Scope   string
	Agents  []string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "jl-skill:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	o, err := parse(args)
	if err != nil {
		return err
	}
	if o.Command == "update" {
		return update(o)
	}
	return install(o)
}

func parse(args []string) (opts, error) {
	o := opts{Command: "install"}
	if len(args) > 0 {
		switch args[0] {
		case "update":
			o.Command, args = "update", args[1:]
		case "install":
			args = args[1:]
		case "-h", "--help", "help":
			help()
			os.Exit(0)
		case "--version", "version":
			fmt.Println(version)
			os.Exit(0)
		}
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--scope":
			if i+1 >= len(args) {
				return o, errors.New("--scope requires a value")
			}
			i++
			o.Scope = args[i]
		case strings.HasPrefix(a, "--scope="):
			o.Scope = strings.TrimPrefix(a, "--scope=")
		case a == "--agent":
			if i+1 >= len(args) {
				return o, errors.New("--agent requires a value")
			}
			i++
			o.Agents = append(o.Agents, args[i])
		case strings.HasPrefix(a, "--agent="):
			o.Agents = append(o.Agents, strings.TrimPrefix(a, "--agent="))
		case strings.HasPrefix(a, "-"):
			return o, fmt.Errorf("unknown option %s", a)
		default:
			o.Skills = append(o.Skills, a)
		}
	}
	return o, nil
}

func help() {
	fmt.Print(`jl-skill

Install:
  jl-skill map --scope user
  jl-skill map --scope cwd
  jl-skill map --scope "C:\\path\\to\\project"
  jl-skill map --scope cwd --agent codex --agent claude

Update:
  jl-skill update map [--scope user|cwd|PATH] [--agent AGENT]...

With no arguments, missing install choices are prompted interactively.
Without --agent, all detected supported harnesses are selected.
`)
}

func install(o opts) error {
	interactive := terminal()
	wizard := len(o.Skills) == 0 || o.Scope == ""
	var err error
	if len(o.Skills) == 0 {
		if !interactive {
			return errors.New("no skill supplied")
		}
		o.Skills, err = askSkills()
		if err != nil {
			return err
		}
	}
	if o.Scope == "" {
		if !interactive {
			return errors.New("--scope is required")
		}
		o.Scope, err = askScope()
		if err != nil {
			return err
		}
	}
	s, err := resolveScope(o.Scope)
	if err != nil {
		return err
	}

	agents := o.Agents
	if len(agents) == 0 {
		agents = detectedAgents()
		if len(agents) == 0 {
			if !interactive {
				return errors.New("no supported harness detected; specify --agent")
			}
			agents, err = askAgents(nil)
			if err != nil {
				return err
			}
		} else if wizard {
			agents, err = askAgents(agents)
			if err != nil {
				return err
			}
		}
	}
	agents, err = normalizeAgents(agents)
	if err != nil {
		return err
	}

	fmt.Printf("Scope: %s\nAgents: %s\nSkills: %s\n", s.Identity, strings.Join(agents, ", "), strings.Join(o.Skills, ", "))
	for _, name := range o.Skills {
		m, err := loadManifest(name)
		if err != nil {
			return err
		}
		if err := installOne(m, s, agents); err != nil {
			return err
		}
	}
	return nil
}

func update(o opts) error {
	r, err := loadRegistry()
	if err != nil {
		return err
	}
	if len(r.Installations) == 0 {
		return errors.New("no recorded installations")
	}
	var sf scope
	if o.Scope != "" {
		sf, err = resolveScope(o.Scope)
		if err != nil {
			return err
		}
	}
	wantedSkills := set(o.Skills)
	wantedAgents := set(o.Agents)
	groups := map[string]struct {
		M      manifest
		S      scope
		Agents []string
	}{}
	for _, x := range r.Installations {
		if len(wantedSkills) > 0 && !wantedSkills[x.Skill] {
			continue
		}
		if len(wantedAgents) > 0 && !wantedAgents[x.Agent] {
			continue
		}
		if o.Scope != "" && x.Scope.Identity != sf.Identity {
			continue
		}
		m, err := loadManifest(x.Skill)
		if err != nil {
			return err
		}
		k := x.Skill + "\x00" + x.Scope.Identity
		g := groups[k]
		g.M, g.S = m, x.Scope
		g.Agents = append(g.Agents, x.Agent)
		groups[k] = g
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
		return m, err
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
	data := filepath.Join(s.Root, ".jl-skill")
	pkg := filepath.Join(data, "packages", m.Name)
	runtimeRoot := filepath.Join(data, "runtime", m.Name)
	for _, rel := range m.RuntimeFiles {
		if err := extract(m.Name, rel, filepath.Join(pkg, rel), nil); err != nil {
			return err
		}
	}
	cli, err := provisionRuntime(m, pkg, runtimeRoot)
	if err != nil {
		return err
	}
	fragment := ""
	if m.InstructionFragment != "" {
		b, err := catalog.ReadFile("skills/" + m.Name + "/" + m.InstructionFragment)
		if err != nil {
			return err
		}
		fragment = string(b)
	}
	for _, agent := range agents {
		skillRoot, instruction, err := agentPaths(agent, s)
		if err != nil {
			return err
		}
		dest := filepath.Join(skillRoot, m.Name)
		for _, rel := range m.SkillFiles {
			repl := map[string]string{"{{JL_MAP_CLI}}": quoteCLI(cli)}
			if err := extract(m.Name, rel, filepath.Join(dest, rel), repl); err != nil {
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
	if s.Kind == "project" && len(m.ProjectInit) > 0 && m.ProjectInit[0] == "map-state" {
		args := append([]string{"--root", s.Root}, m.ProjectInit[1:]...)
		cmd := exec.Command(cli, args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s project init: %w", m.Name, err)
		}
	}
	return nil
}

func provisionRuntime(m manifest, pkg, root string) (string, error) {
	if m.Runtime != "python" {
		return "", fmt.Errorf("unsupported runtime %q", m.Runtime)
	}
	py, prefix, err := python311()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	deps := filepath.Join(root, "site-packages")
	if len(m.RuntimeDependencies) > 0 {
		if err := os.MkdirAll(deps, 0o755); err != nil {
			return "", err
		}
		args := append(append([]string{}, prefix...), "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "--target", deps)
		args = append(args, m.RuntimeDependencies...)
		cmd := exec.Command(py, args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("install runtime dependencies: %w", err)
		}
	}
	runner := filepath.Join(root, "runner.py")
	body := fmt.Sprintf("import sys\nsys.path.insert(0, %q)\nsys.path.insert(0, %q)\nfrom map_entry import main\nraise SystemExit(main())\n", deps, pkg)
	if err := atomicWrite(runner, []byte(body), 0o644); err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		cli := filepath.Join(root, "map-state.cmd")
		body := fmt.Sprintf("@echo off\r\n\"%s\" \"%s\" %%*\r\n", py, runner)
		return cli, atomicWrite(cli, []byte(body), 0o755)
	}
	cli := filepath.Join(root, "map-state")
	body = fmt.Sprintf("#!/bin/sh\nexec \"%s\" \"%s\" \"$@\"\n", py, runner)
	return cli, atomicWrite(cli, []byte(body), 0o755)
}

func python311() (string, []string, error) {
	candidates := [][]string{{"python"}, {"python3"}}
	if runtime.GOOS == "windows" {
		candidates = [][]string{{"python"}, {"py", "-3"}, {"python3"}}
	}
	for _, c := range candidates {
		p, err := exec.LookPath(c[0])
		if err != nil {
			continue
		}
		prefix := c[1:]
		args := append(append([]string{}, prefix...), "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)")
		if exec.Command(p, args...).Run() == nil {
			return p, prefix, nil
		}
	}
	return "", nil, errors.New("Map currently requires Python 3.11+; no compatible interpreter was found")
}

func extract(skill, rel, dest string, replacements map[string]string) error {
	b, err := catalog.ReadFile("skills/" + skill + "/" + filepath.ToSlash(rel))
	if err != nil {
		return err
	}
	text := string(b)
	for from, to := range replacements {
		text = strings.ReplaceAll(text, from, to)
	}
	return atomicWrite(dest, []byte(text), 0o644)
}

func quoteCLI(p string) string {
	if runtime.GOOS == "windows" {
		p = filepath.ToSlash(p)
	}
	return `"` + strings.ReplaceAll(p, `"`, `\"`) + `"`
}

func agentPaths(agent string, s scope) (skillRoot, instruction string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	base := s.Root
	if s.Kind == "user" {
		base = home
	}
	switch agent {
	case "codex":
		if s.Kind == "user" {
			return filepath.Join(home, ".agents", "skills"), filepath.Join(home, ".codex", "AGENTS.md"), nil
		}
		return filepath.Join(base, ".agents", "skills"), filepath.Join(base, "AGENTS.md"), nil
	case "claude":
		if s.Kind == "user" {
			return filepath.Join(home, ".claude", "skills"), filepath.Join(home, ".claude", "CLAUDE.md"), nil
		}
		return filepath.Join(base, ".claude", "skills"), filepath.Join(base, "CLAUDE.md"), nil
	default:
		return "", "", fmt.Errorf("unsupported agent %q", agent)
	}
}

func detectedAgents() []string {
	var out []string
	if detected("codex", ".codex") {
		out = append(out, "codex")
	}
	if detected("claude", ".claude") {
		out = append(out, "claude")
	}
	return out
}

func detected(command, marker string) bool {
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

func normalizeAgents(in []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, raw := range in {
		a := strings.ToLower(strings.TrimSpace(raw))
		if a == "claude-code" {
			a = "claude"
		}
		if a != "codex" && a != "claude" {
			return nil, fmt.Errorf("unsupported agent %q", raw)
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
		home, err = canonical(home)
		return scope{Kind: "user", Identity: "user", Root: home}, err
	}
	if raw == "cwd" {
		cwd, err := os.Getwd()
		if err != nil {
			return scope{}, err
		}
		p, err := canonical(cwd)
		return scope{Kind: "project", Identity: p, Root: p}, err
	}
	if raw == "" {
		return scope{}, errors.New("empty scope")
	}
	p := os.ExpandEnv(raw)
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return scope{}, err
		}
		if p == "~" {
			p = home
		} else {
			p = filepath.Join(home, p[2:])
		}
	}
	p, err := canonical(p)
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

func canonical(p string) (string, error) {
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
	begin := "<!-- jl-skill:begin " + skill + " -->"
	end := "<!-- jl-skill:end " + skill + " -->"
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
		ei += len(end)
		current = current[:bi] + block + current[ei:]
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
	tmp, err := os.CreateTemp(filepath.Dir(path), ".jl-skill-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		_ = os.Remove(path + ".jl-skill-old")
		if _, err := os.Stat(path); err == nil {
			if err := os.Rename(path, path+".jl-skill-old"); err != nil {
				return err
			}
			if err := os.Rename(name, path); err != nil {
				_ = os.Rename(path+".jl-skill-old", path)
				return err
			}
			_ = os.Remove(path + ".jl-skill-old")
			return nil
		}
	}
	return os.Rename(name, path)
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
	p, err := registryPath()
	if err != nil {
		return r, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	return r, json.Unmarshal(b, &r)
}

func saveReceipt(x receipt) error {
	r, err := loadRegistry()
	if err != nil {
		return err
	}
	found := false
	for i := range r.Installations {
		old := &r.Installations[i]
		if old.Skill == x.Skill && old.Agent == x.Agent && old.Scope.Identity == x.Scope.Identity {
			*old, found = x, true
			break
		}
	}
	if !found {
		r.Installations = append(r.Installations, x)
	}
	p, _ := registryPath()
	b, _ := json.MarshalIndent(r, "", "  ")
	return atomicWrite(p, append(b, '\n'), 0o644)
}

func set(items []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range items {
		m[strings.ToLower(strings.TrimSpace(x))] = true
	}
	return m
}

var stdin = bufio.NewReader(os.Stdin)

func ask(label string) (string, error) {
	fmt.Print("? " + label + ": ")
	s, err := stdin.ReadString('\n')
	if err != nil && len(s) == 0 {
		return "", err
	}
	return strings.TrimSpace(s), nil
}

func askSkills() ([]string, error) {
	entries, err := fs.ReadDir(catalog, "skills")
	if err != nil {
		return nil, err
	}
	var names []string
	fmt.Println("Available skills:")
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		m, err := loadManifest(e.Name())
		if err != nil {
			continue
		}
		names = append(names, m.Name)
		fmt.Printf("  %d) %s - %s\n", len(names), m.Name, m.Description)
	}
	line, err := ask("Skills (comma-separated names or numbers)")
	if err != nil {
		return nil, err
	}
	var out []string
	for _, t := range strings.Split(line, ",") {
		t = strings.TrimSpace(t)
		var n int
		if _, err := fmt.Sscanf(t, "%d", &n); err == nil && n >= 1 && n <= len(names) {
			out = append(out, names[n-1])
		} else if t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no skills selected")
	}
	return out, nil
}

func askScope() (string, error) {
	fmt.Println("Installation scope:\n  1) cwd\n  2) user\n  3) custom path")
	x, err := ask("Scope")
	if err != nil {
		return "", err
	}
	switch x {
	case "", "1", "cwd":
		return "cwd", nil
	case "2", "user":
		return "user", nil
	case "3":
		return ask("Path")
	default:
		return x, nil
	}
}

func askAgents(defaults []string) ([]string, error) {
	fmt.Println("Detected/default agents: " + strings.Join(defaults, ", "))
	x, err := ask("Agents (comma-separated; blank keeps defaults)")
	if err != nil {
		return nil, err
	}
	if x == "" && len(defaults) > 0 {
		return defaults, nil
	}
	var out []string
	for _, a := range strings.Split(x, ",") {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return normalizeAgents(out)
}

func terminal() bool {
	st, err := os.Stdin.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

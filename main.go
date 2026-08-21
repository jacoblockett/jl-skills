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
	"strconv"
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

type options struct {
	Command string
	Skills  []string
	Scope   string
	Agents  []string
}

type pythonInvocation struct {
	Exe    string
	Prefix []string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "jl-skill:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	o, err := parseArgs(args)
	if err != nil {
		return err
	}
	if o.Command == "update" {
		return update(o)
	}
	return install(o)
}

func parseArgs(args []string) (options, error) {
	o := options{Command: "install"}
	if len(args) > 0 {
		switch args[0] {
		case "install":
			args = args[1:]
		case "update":
			o.Command = "update"
			args = args[1:]
		case "help", "-h", "--help":
			printHelp()
			os.Exit(0)
		case "version", "--version":
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

func printHelp() {
	fmt.Print(`jl-skill

Install skills:
  jl-skill map --scope user
  jl-skill map --scope cwd
  jl-skill map --scope "C:\\path\\to\\project"
  jl-skill map --scope cwd --agent codex --agent claude

Update installed skills:
  jl-skill update map [--scope user|cwd|PATH] [--agent AGENT]...

Scope chooses WHERE. Agent detection chooses WHO. Detecting a harness never changes
or broadens the requested scope.

With no --agent, all detected supported harnesses are selected. Missing install
choices are prompted when stdin is interactive.
`)
}

func install(o options) error {
	interactive := isTerminal()
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
		detected := detectedAgents()
		if len(detected) == 0 {
			if !interactive {
				return errors.New("no supported harness detected; specify --agent explicitly")
			}
			agents, err = askAgents(nil)
		} else if wizard {
			agents, err = askAgents(detected)
		} else {
			agents = detected
		}
		if err != nil {
			return err
		}
	}
	agents, err = normalizeAgents(agents)
	if err != nil {
		return err
	}
	if len(agents) == 0 {
		return errors.New("no agents selected")
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

func update(o options) error {
	r, err := loadRegistry()
	if err != nil {
		return err
	}
	if len(r.Installations) == 0 {
		return errors.New("no recorded installations")
	}

	var scopeFilter scope
	if o.Scope != "" {
		scopeFilter, err = resolveScope(o.Scope)
		if err != nil {
			return err
		}
	}

	wantedSkills := stringSet(o.Skills)
	wantedAgents := stringSet(o.Agents)
	type group struct {
		Manifest manifest
		Scope    scope
		Agents   []string
	}
	groups := map[string]group{}

	for _, x := range r.Installations {
		if len(wantedSkills) > 0 && !wantedSkills[x.Skill] {
			continue
		}
		if len(wantedAgents) > 0 && !wantedAgents[x.Agent] {
			continue
		}
		if o.Scope != "" && x.Scope.Identity != scopeFilter.Identity {
			continue
		}
		m, err := loadManifest(x.Skill)
		if err != nil {
			return err
		}
		key := x.Skill + "\x00" + x.Scope.Identity
		g := groups[key]
		g.Manifest = m
		g.Scope = x.Scope
		g.Agents = append(g.Agents, x.Agent)
		groups[key] = g
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
		fmt.Printf("Updating %s at %s for %s\n", g.Manifest.Name, g.Scope.Identity, strings.Join(agents, ", "))
		if err := installOne(g.Manifest, g.Scope, agents); err != nil {
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
		skillRoot, instructionFile, err := agentPaths(agent, s)
		if err != nil {
			return err
		}
		destination := filepath.Join(skillRoot, m.Name)
		for _, rel := range m.SkillFiles {
			if err := extractAsset(m.Name, rel, filepath.Join(destination, rel), tokens); err != nil {
				return err
			}
		}
		if fragment != "" {
			if err := managedBlock(instructionFile, m.Name, fragment); err != nil {
				return err
			}
		}
		if err := saveReceipt(receipt{
			Skill:       m.Name,
			Version:     m.Version,
			Scope:       s,
			Agent:       agent,
			SkillPath:   destination,
			RuntimeRoot: runtimeRoot,
			UpdatedAt:   time.Now().UTC(),
		}); err != nil {
			return err
		}
		fmt.Printf("Installed %s %s for %s at %s\n", m.Name, m.Version, agent, destination)
	}

	if s.Kind == "project" && len(m.ProjectInit) > 0 {
		if m.ProjectInit[0] != "map-state" {
			return fmt.Errorf("unsupported project initializer %q", m.ProjectInit[0])
		}
		args := append([]string{"--root", s.Root}, m.ProjectInit[1:]...)
		cmd := exec.Command(cli, args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
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
	py, err := findPython311()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(runtimeRoot, 0o755); err != nil {
		return "", err
	}

	depsRoot := filepath.Join(runtimeRoot, "site-packages")
	if len(m.RuntimeDependencies) > 0 {
		if err := os.MkdirAll(depsRoot, 0o755); err != nil {
			return "", err
		}
		args := append([]string{}, py.Prefix...)
		args = append(args, "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "--target", depsRoot)
		args = append(args, m.RuntimeDependencies...)
		cmd := exec.Command(py.Exe, args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("install runtime dependencies: %w", err)
		}
	}

	runner := filepath.Join(runtimeRoot, "runner.py")
	runnerBody := fmt.Sprintf(
		"import sys\nsys.path.insert(0, %q)\nsys.path.insert(0, %q)\nfrom map_entry import main\nraise SystemExit(main())\n",
		depsRoot,
		packageRoot,
	)
	if err := atomicWrite(runner, []byte(runnerBody), 0o644); err != nil {
		return "", err
	}

	if runtime.GOOS == "windows" {
		cli := filepath.Join(runtimeRoot, "map-state.cmd")
		parts := []string{cmdQuote(py.Exe)}
		for _, p := range py.Prefix {
			parts = append(parts, cmdQuote(p))
		}
		parts = append(parts, cmdQuote(runner), "%*")
		body := "@echo off\r\n" + strings.Join(parts, " ") + "\r\n"
		return cli, atomicWrite(cli, []byte(body), 0o755)
	}

	cli := filepath.Join(runtimeRoot, "map-state")
	parts := []string{"exec", shQuote(py.Exe)}
	for _, p := range py.Prefix {
		parts = append(parts, shQuote(p))
	}
	parts = append(parts, shQuote(runner), `"$@"`)
	body := "#!/bin/sh\n" + strings.Join(parts, " ") + "\n"
	return cli, atomicWrite(cli, []byte(body), 0o755)
}

func findPython311() (pythonInvocation, error) {
	candidates := []pythonInvocation{{Exe: "python3"}, {Exe: "python"}}
	if runtime.GOOS == "windows" {
		candidates = []pythonInvocation{{Exe: "python"}, {Exe: "py", Prefix: []string{"-3"}}, {Exe: "python3"}}
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
	return pythonInvocation{}, errors.New("Map currently requires Python 3.11+; no compatible interpreter was found")
}

func extractAsset(skill, rel, destination string, tokens map[string]string) error {
	b, err := catalog.ReadFile("skills/" + skill + "/" + filepath.ToSlash(rel))
	if err != nil {
		return err
	}
	if tokens != nil {
		b = []byte(render(string(b), tokens))
	}
	return atomicWrite(destination, b, 0o644)
}

func render(s string, tokens map[string]string) string {
	for from, to := range tokens {
		s = strings.ReplaceAll(s, from, to)
	}
	return s
}

func agentPaths(agent string, s scope) (skillRoot, instructionFile string, err error) {
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
	if harnessDetected("codex", ".codex") {
		out = append(out, "codex")
	}
	if harnessDetected("claude", ".claude") {
		out = append(out, "claude")
	}
	return out
}

func harnessDetected(command, homeMarker string) bool {
	if _, err := exec.LookPath(command); err == nil {
		return true
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	st, err := os.Stat(filepath.Join(home, homeMarker))
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
	switch raw {
	case "user":
		home, err := os.UserHomeDir()
		if err != nil {
			return scope{}, err
		}
		home, err = canonicalPath(home)
		return scope{Kind: "user", Identity: "user", Root: home}, err
	case "cwd":
		cwd, err := os.Getwd()
		if err != nil {
			return scope{}, err
		}
		p, err := canonicalPath(cwd)
		return scope{Kind: "project", Identity: p, Root: p}, err
	case "":
		return scope{}, errors.New("empty scope")
	}

	p := expandPath(raw)
	p, err := canonicalPath(p)
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
		p = expandWindowsPercentVars(p)
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

func expandWindowsPercentVars(s string) string {
	for {
		start := strings.IndexByte(s, '%')
		if start < 0 {
			return s
		}
		endRel := strings.IndexByte(s[start+1:], '%')
		if endRel < 0 {
			return s
		}
		end := start + 1 + endRel
		name := s[start+1 : end]
		value, ok := os.LookupEnv(name)
		if !ok {
			return s
		}
		s = s[:start] + value + s[end+1:]
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
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
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

	beginIndex := strings.Index(current, begin)
	endIndex := strings.Index(current, end)
	if (beginIndex >= 0) != (endIndex >= 0) {
		return fmt.Errorf("malformed jl-skill block in %s", path)
	}
	if beginIndex >= 0 {
		if strings.Count(current, begin) != 1 || strings.Count(current, end) != 1 || endIndex < beginIndex {
			return fmt.Errorf("ambiguous jl-skill block in %s", path)
		}
		endIndex += len(end)
		current = current[:beginIndex] + block + current[endIndex:]
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
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

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
		backup := path + ".jl-skill-old"
		_ = os.Remove(backup)
		if _, err := os.Stat(path); err == nil {
			if err := os.Rename(path, backup); err != nil {
				return err
			}
			if err := os.Rename(tmpName, path); err != nil {
				_ = os.Rename(backup, path)
				return err
			}
			_ = os.Remove(backup)
			return nil
		}
	}
	return os.Rename(tmpName, path)
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
	if err := json.Unmarshal(b, &r); err != nil {
		return r, fmt.Errorf("parse registry: %w", err)
	}
	return r, nil
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
			*old = x
			found = true
			break
		}
	}
	if !found {
		r.Installations = append(r.Installations, x)
	}
	p, err := registryPath()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(p, append(b, '\n'), 0o644)
}

func stringSet(items []string) map[string]bool {
	m := map[string]bool{}
	for _, item := range items {
		m[strings.ToLower(strings.TrimSpace(item))] = true
	}
	return m
}

func cmdQuote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
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
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		m, err := loadManifest(entry.Name())
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
	for _, token := range strings.Split(line, ",") {
		token = strings.TrimSpace(token)
		if n, err := strconv.Atoi(token); err == nil && n >= 1 && n <= len(names) {
			out = append(out, names[n-1])
		} else if token != "" {
			out = append(out, token)
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
	if len(defaults) > 0 {
		fmt.Println("Detected agents: " + strings.Join(defaults, ", "))
	} else {
		fmt.Println("No supported agents were detected. Supported: codex, claude")
	}
	x, err := ask("Agents (comma-separated; blank keeps detected defaults)")
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

func isTerminal() bool {
	st, err := os.Stdin.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

package main

import (
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

	"github.com/jacoblockett/jl-skills/internal/catalog"
)

const version = "0.4.0"

type manifest struct {
	Name                string            `json:"name"`
	Version             string            `json:"version"`
	Description         string            `json:"description"`
	SkillFiles          []string          `json:"skill_files"`
	RuntimeFiles        []string          `json:"runtime_files"`
	Runtime             string            `json:"runtime"`
	RuntimeArtifacts    map[string]string `json:"runtime_artifacts"`
	RuntimeSharedFiles  map[string]string `json:"runtime_shared_files"`
	RuntimeCLI          string            `json:"runtime_cli"`
	CLIToken            string            `json:"cli_token"`
	InstructionFragment string            `json:"instruction_fragment"`
}

type scope struct {
	Kind     string `json:"kind"`
	Identity string `json:"identity"`
	Root     string `json:"root"`
}

type receipt struct {
	Skill       string `json:"skill"`
	Version     string `json:"version"`
	Scope       scope  `json:"scope"`
	Agent       string `json:"agent"`
	SkillPath   string `json:"skill_path"`
	RuntimeRoot string `json:"runtime_root"`
	UpdatedAt   string `json:"updated_at"`
}

type registry struct {
	Installations []receipt `json:"installations"`
}

type parsed struct {
	Skills []string
	Scope  string
	Agents []string
}

type agentSpec struct {
	ID      string
	Command string
}

var agents = []agentSpec{
	{ID: "codex", Command: "codex"},
	{ID: "claude", Command: "claude"},
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "jl-skill:", err)
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Printf("jl-skill %s\n", version)
		return nil
	}
	if len(args) == 0 || contains(args, "--help") || contains(args, "-h") || args[0] == "help" {
		printHelp()
		if len(args) == 0 {
			return errors.New("interactive wizard is not wired yet; use an explicit install command for this smoke-test build")
		}
		return nil
	}
	if args[0] == "update" {
		return update(parseArgs(args[1:]))
	}
	if args[0] == "install" {
		args = args[1:]
	}
	return install(parseArgs(args))
}

func printHelp() {
	fmt.Println(`jl-skill

Usage:
  jl-skill [skills...] --scope user|cwd|PATH [--agent AGENT]...
  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...

Supported harnesses: codex, claude`)
}

func parseArgs(args []string) parsed {
	var out parsed
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--scope":
			if i+1 >= len(args) {
				out.Scope = "\x00missing"
				continue
			}
			i++
			out.Scope = args[i]
		case strings.HasPrefix(arg, "--scope="):
			out.Scope = strings.TrimPrefix(arg, "--scope=")
		case arg == "--agent":
			if i+1 >= len(args) {
				out.Agents = append(out.Agents, "\x00missing")
				continue
			}
			i++
			out.Agents = append(out.Agents, args[i])
		case strings.HasPrefix(arg, "--agent="):
			out.Agents = append(out.Agents, strings.TrimPrefix(arg, "--agent="))
		case strings.HasPrefix(arg, "-"):
			out.Skills = append(out.Skills, "\x00option:"+arg)
		default:
			out.Skills = append(out.Skills, arg)
		}
	}
	return out
}

func install(p parsed) error {
	if err := validateParsed(p, true); err != nil {
		return err
	}
	manifests, err := loadCatalog()
	if err != nil {
		return err
	}
	target, err := resolveScope(p.Scope)
	if err != nil {
		return err
	}
	selectedAgents, err := chooseAgents(p.Agents)
	if err != nil {
		return err
	}

	fmt.Println("Scope:", target.Identity)
	fmt.Println("Agents:", strings.Join(selectedAgents, ", "))
	fmt.Println("Skills:", strings.Join(p.Skills, ", "))
	for _, name := range p.Skills {
		m, ok := manifests[name]
		if !ok {
			return fmt.Errorf("unknown skill %q", name)
		}
		if err := installOne(m, target, selectedAgents); err != nil {
			return err
		}
	}
	return nil
}

func update(p parsed) error {
	if err := validateParsed(p, false); err != nil {
		return err
	}
	manifests, err := loadCatalog()
	if err != nil {
		return err
	}
	reg, err := loadRegistry()
	if err != nil {
		return err
	}
	requestedAgents, err := normalizeAgents(p.Agents)
	if err != nil {
		return err
	}
	var requestedScope *scope
	if p.Scope != "" {
		value, err := resolveScope(p.Scope)
		if err != nil {
			return err
		}
		requestedScope = &value
	}
	requestedSkills := stringSet(p.Skills)
	agentFilter := stringSet(requestedAgents)

	type group struct {
		Skill  string
		Scope  scope
		Agents []string
	}
	groups := map[string]*group{}
	for _, r := range reg.Installations {
		if len(requestedSkills) > 0 && !requestedSkills[r.Skill] {
			continue
		}
		if requestedScope != nil && requestedScope.Identity != r.Scope.Identity {
			continue
		}
		if len(agentFilter) > 0 && !agentFilter[r.Agent] {
			continue
		}
		key := r.Skill + "\x00" + r.Scope.Kind + "\x00" + r.Scope.Identity
		g := groups[key]
		if g == nil {
			g = &group{Skill: r.Skill, Scope: r.Scope}
			groups[key] = g
		}
		if !contains(g.Agents, r.Agent) {
			g.Agents = append(g.Agents, r.Agent)
		}
	}
	if len(groups) == 0 {
		return errors.New("no installations match update filters")
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		g := groups[key]
		m, ok := manifests[g.Skill]
		if !ok {
			return fmt.Errorf("installed skill %q is not in this catalog", g.Skill)
		}
		sort.Strings(g.Agents)
		fmt.Printf("Updating %s at %s for %s\n", g.Skill, g.Scope.Identity, strings.Join(g.Agents, ", "))
		if err := installOne(m, g.Scope, g.Agents); err != nil {
			return err
		}
	}
	return nil
}

func validateParsed(p parsed, requireInstallFields bool) error {
	if p.Scope == "\x00missing" {
		return errors.New("--scope requires user, cwd, or a path")
	}
	for _, agent := range p.Agents {
		if agent == "\x00missing" {
			return errors.New("--agent requires a harness name")
		}
	}
	for _, skill := range p.Skills {
		if strings.HasPrefix(skill, "\x00option:") {
			return fmt.Errorf("unknown option %s", strings.TrimPrefix(skill, "\x00option:"))
		}
	}
	if requireInstallFields {
		if len(p.Skills) == 0 {
			return errors.New("no skills selected")
		}
		if strings.TrimSpace(p.Scope) == "" {
			return errors.New("--scope is required for explicit install")
		}
	}
	return nil
}

func loadCatalog() (map[string]manifest, error) {
	entries, err := fs.ReadDir(catalog.FS, "assets/catalog")
	if err != nil {
		return nil, fmt.Errorf("read embedded catalog: %w", err)
	}
	out := map[string]manifest{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data, err := fs.ReadFile(catalog.FS, "assets/catalog/"+entry.Name()+"/jl-skill.json")
		if err != nil {
			return nil, err
		}
		var m manifest
		if err := json.Unmarshal(data, &m); err != nil {
			return nil, fmt.Errorf("parse embedded manifest %s: %w", entry.Name(), err)
		}
		if m.Name == "" || m.Version == "" || len(m.SkillFiles) == 0 {
			return nil, fmt.Errorf("invalid embedded manifest %s", entry.Name())
		}
		out[m.Name] = m
	}
	return out, nil
}

func resolveScope(raw string) (scope, error) {
	value := strings.TrimSpace(raw)
	switch value {
	case "user":
		home, err := userHome()
		if err != nil {
			return scope{}, err
		}
		return scope{Kind: "user", Identity: "user", Root: home}, nil
	case "cwd":
		cwd, err := os.Getwd()
		if err != nil {
			return scope{}, err
		}
		root, err := canonicalPath(cwd)
		if err != nil {
			return scope{}, err
		}
		return scope{Kind: "project", Identity: root, Root: root}, nil
	case "":
		return scope{}, errors.New("empty scope")
	default:
		root, err := canonicalPath(expandPath(value))
		if err != nil {
			return scope{}, err
		}
		if info, err := os.Stat(root); err == nil && !info.IsDir() {
			return scope{}, fmt.Errorf("scope path is not a directory: %s", root)
		} else if err != nil && !os.IsNotExist(err) {
			return scope{}, err
		}
		return scope{Kind: "project", Identity: root, Root: root}, nil
	}
}

func chooseAgents(explicit []string) ([]string, error) {
	if len(explicit) > 0 {
		return normalizeAgents(explicit)
	}
	var detected []string
	for _, spec := range agents {
		if harnessDetected(spec) {
			detected = append(detected, spec.ID)
		}
	}
	if len(detected) == 0 {
		return nil, errors.New("no supported harness detected; specify --agent")
	}
	sort.Strings(detected)
	return detected, nil
}

func normalizeAgents(values []string) ([]string, error) {
	set := map[string]bool{}
	for _, raw := range values {
		id := strings.ToLower(strings.TrimSpace(raw))
		if id == "claude-code" {
			id = "claude"
		}
		if !knownAgent(id) {
			return nil, fmt.Errorf("unsupported agent %q", raw)
		}
		set[id] = true
	}
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}

func knownAgent(id string) bool {
	for _, spec := range agents {
		if spec.ID == id {
			return true
		}
	}
	return false
}

func harnessDetected(spec agentSpec) bool {
	if _, err := exec.LookPath(spec.Command); err == nil {
		return true
	}
	home, err := userHome()
	if err != nil {
		return false
	}
	var candidates []string
	switch spec.ID {
	case "codex":
		candidates = []string{
			filepath.Join(home, ".codex", "config.toml"),
			filepath.Join(home, ".codex", "sessions"),
			filepath.Join(home, ".codex", "AGENTS.md"),
		}
	case "claude":
		candidates = []string{
			filepath.Join(home, ".claude", "settings.json"),
			filepath.Join(home, ".claude", "projects"),
			filepath.Join(home, ".claude.json"),
		}
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return true
		}
	}
	return false
}

func installOne(m manifest, target scope, selectedAgents []string) error {
	if target.Kind == "project" {
		if err := os.MkdirAll(target.Root, 0o755); err != nil {
			return err
		}
	}
	cli, runtimeRoot, err := provisionRuntime(m, target)
	if err != nil {
		return err
	}
	tokenName := m.CLIToken
	if tokenName == "" {
		tokenName = "JL_SKILL_CLI"
	}
	tokens := map[string]string{"{{" + tokenName + "}}": filepath.Clean(cli)}

	fragment := ""
	if m.InstructionFragment != "" {
		data, err := readAsset(m.Name, m.InstructionFragment)
		if err != nil {
			return err
		}
		fragment = render(string(data), tokens)
	}

	var pending []receipt
	for _, agent := range selectedAgents {
		skillRoot, instruction, err := agentPaths(agent, target)
		if err != nil {
			return err
		}
		dest := filepath.Join(skillRoot, m.Name)
		for _, rel := range m.SkillFiles {
			data, err := readAsset(m.Name, rel)
			if err != nil {
				return err
			}
			if err := atomicWrite(filepath.Join(dest, filepath.FromSlash(rel)), []byte(render(string(data), tokens)), 0o644); err != nil {
				return err
			}
		}
		if fragment != "" {
			if err := managedBlock(instruction, m.Name, fragment); err != nil {
				return err
			}
		}
		if _, err := os.Stat(dest); err != nil {
			return fmt.Errorf("validation failed: missing installed skill path %s", dest)
		}
		pending = append(pending, receipt{
			Skill:       m.Name,
			Version:     m.Version,
			Scope:       target,
			Agent:       agent,
			SkillPath:   dest,
			RuntimeRoot: runtimeRoot,
			UpdatedAt:   time.Now().UTC().Format(time.RFC3339),
		})
	}
	for _, r := range pending {
		if err := saveReceipt(r); err != nil {
			return err
		}
		fmt.Printf("Installed %s %s for %s at %s\n", m.Name, m.Version, r.Agent, r.SkillPath)
	}
	return nil
}

func provisionRuntime(m manifest, target scope) (string, string, error) {
	if m.Runtime != "rust" {
		return "", "", fmt.Errorf("unsupported runtime %q", m.Runtime)
	}
	if m.RuntimeCLI == "" {
		return "", "", fmt.Errorf("%s manifest is missing runtime_cli", m.Name)
	}
	key := runtimePlatformKey()
	artifact := m.RuntimeArtifacts[key]
	if artifact == "" {
		return "", "", fmt.Errorf("%s has no bundled runtime for %s", m.Name, key)
	}
	root, err := runtimeInstallRoot(m, target)
	if err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", "", err
	}
	cliName := m.RuntimeCLI
	if runtime.GOOS == "windows" {
		cliName += ".exe"
	}
	cli := filepath.Join(root, cliName)
	data, err := readAsset(m.Name, artifact)
	if err != nil {
		return "", "", err
	}
	if err := atomicWrite(cli, data, 0o755); err != nil {
		return "", "", err
	}
	for _, rel := range m.RuntimeFiles {
		data, err := readAsset(m.Name, rel)
		if err != nil {
			return "", "", err
		}
		if err := atomicWrite(filepath.Join(root, filepath.FromSlash(rel)), data, 0o644); err != nil {
			return "", "", err
		}
	}
	for rel, destination := range m.RuntimeSharedFiles {
		data, err := readAsset(m.Name, rel)
		if err != nil {
			return "", "", err
		}
		dest, err := canonicalPath(expandPath(destination))
		if err != nil {
			return "", "", err
		}
		if err := atomicWrite(dest, data, 0o644); err != nil {
			return "", "", err
		}
	}
	if _, err := os.Stat(cli); err != nil {
		return "", "", fmt.Errorf("validation failed: missing runtime executable %s", cli)
	}
	return cli, root, nil
}

func runtimePlatformKey() string {
	if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
		return "windows-x64"
	}
	if runtime.GOOS == "linux" && runtime.GOARCH == "amd64" {
		return "linux-x64"
	}
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		return "macos-arm64"
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

func runtimeInstallRoot(m manifest, target scope) (string, error) {
	if target.Kind == "user" {
		root, err := installerDataRoot()
		if err != nil {
			return "", err
		}
		return filepath.Join(root, m.Name, "runtime", m.Version), nil
	}
	return filepath.Join(target.Root, ".jl-skill", "runtime", m.Name, m.Version), nil
}

func agentPaths(agent string, target scope) (string, string, error) {
	home, err := userHome()
	if err != nil {
		return "", "", err
	}
	switch agent {
	case "codex":
		if target.Kind == "user" {
			return filepath.Join(home, ".agents", "skills"), filepath.Join(home, ".codex", "AGENTS.md"), nil
		}
		return filepath.Join(target.Root, ".agents", "skills"), filepath.Join(target.Root, "AGENTS.md"), nil
	case "claude":
		if target.Kind == "user" {
			return filepath.Join(home, ".claude", "skills"), filepath.Join(home, ".claude", "CLAUDE.md"), nil
		}
		return filepath.Join(target.Root, ".claude", "skills"), filepath.Join(target.Root, "CLAUDE.md"), nil
	default:
		return "", "", fmt.Errorf("unsupported agent %q", agent)
	}
}

func readAsset(skill, rel string) ([]byte, error) {
	path := "assets/catalog/" + skill + "/" + filepath.ToSlash(rel)
	data, err := fs.ReadFile(catalog.FS, path)
	if err != nil {
		return nil, fmt.Errorf("missing embedded asset %s/%s: %w", skill, rel, err)
	}
	return data, nil
}

func render(text string, tokens map[string]string) string {
	for from, to := range tokens {
		text = strings.ReplaceAll(text, from, to)
	}
	return text
}

func managedBlock(path, skill, fragment string) error {
	begin := "<!-- jl-skill:begin " + skill + " -->"
	end := "<!-- jl-skill:end " + skill + " -->"
	block := begin + "\n" + strings.TrimSpace(fragment) + "\n" + end
	current := ""
	if data, err := os.ReadFile(path); err == nil {
		current = string(data)
	} else if !os.IsNotExist(err) {
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
		current = current[:beginIndex] + block + current[endIndex+len(end):]
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
	cleanup := func() { _ = os.Remove(tmpName) }
	defer cleanup()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	_ = os.Chmod(tmpName, mode)
	if runtime.GOOS == "windows" {
		_ = os.Remove(path)
	}
	return os.Rename(tmpName, path)
}

func registryPath() (string, error) {
	root, err := installerDataRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "registry.json"), nil
}

func loadRegistry() (registry, error) {
	path, err := registryPath()
	if err != nil {
		return registry{}, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return registry{}, nil
	}
	if err != nil {
		return registry{}, err
	}
	var out registry
	if err := json.Unmarshal(data, &out); err != nil {
		return registry{}, fmt.Errorf("read registry: %w", err)
	}
	return out, nil
}

func saveReceipt(value receipt) error {
	reg, err := loadRegistry()
	if err != nil {
		return err
	}
	filtered := reg.Installations[:0]
	for _, old := range reg.Installations {
		if old.Skill == value.Skill && old.Scope.Identity == value.Scope.Identity && old.Agent == value.Agent {
			continue
		}
		filtered = append(filtered, old)
	}
	reg.Installations = append(filtered, value)
	sort.Slice(reg.Installations, func(i, j int) bool {
		a, b := reg.Installations[i], reg.Installations[j]
		if a.Skill != b.Skill {
			return a.Skill < b.Skill
		}
		if a.Scope.Identity != b.Scope.Identity {
			return a.Scope.Identity < b.Scope.Identity
		}
		return a.Agent < b.Agent
	})
	data, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		return err
	}
	path, err := registryPath()
	if err != nil {
		return err
	}
	return atomicWrite(path, append(data, '\n'), 0o644)
}

func installerDataRoot() (string, error) {
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			home, err := userHome()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, "AppData", "Local")
		}
		return canonicalPath(filepath.Join(base, "JL-Skills"))
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := userHome()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "share")
	}
	return canonicalPath(filepath.Join(base, "JL-Skills"))
}

func userHome() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return canonicalPath(home)
}

func canonicalPath(value string) (string, error) {
	absolute, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(absolute); err == nil {
		if real, err := filepath.EvalSymlinks(absolute); err == nil {
			return filepath.Clean(real), nil
		}
	}
	return filepath.Clean(absolute), nil
}

func expandPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "~" || strings.HasPrefix(value, "~/") || strings.HasPrefix(value, "~\\") {
		if home, err := os.UserHomeDir(); err == nil {
			if value == "~" {
				value = home
			} else {
				value = filepath.Join(home, value[2:])
			}
		}
	}
	value = os.ExpandEnv(value)
	if runtime.GOOS == "windows" {
		for {
			start := strings.IndexByte(value, '%')
			if start < 0 {
				break
			}
			endRel := strings.IndexByte(value[start+1:], '%')
			if endRel < 0 {
				break
			}
			end := start + 1 + endRel
			name := value[start+1 : end]
			replacement, ok := os.LookupEnv(name)
			if !ok {
				break
			}
			value = value[:start] + replacement + value[end+1:]
		}
	}
	return value
}

func stringSet(values []string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		out[value] = true
	}
	return out
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

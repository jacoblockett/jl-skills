package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

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

	if len(skills) > 0 {
		if err := validateSkills(skills); err != nil {
			return err
		}
	}

	prompted := false
	if len(skills) == 0 {
		if !interactive {
			return errors.New("no skills selected")
		}
		chosen, err := promptSkills()
		if err != nil {
			return normalizePromptError(err)
		}
		skills = chosen
		prompted = true
	}

	if scopeRaw == "" {
		if !interactive {
			return errors.New("--scope is required in non-interactive mode")
		}
		chosen, err := promptScope()
		if err != nil {
			return normalizePromptError(err)
		}
		scopeRaw = chosen
		prompted = true
	}

	s, err := resolveScope(scopeRaw)
	if err != nil {
		return err
	}

	resolvedAgents, agentPrompted, err := chooseAgents(agents, interactive)
	if err != nil {
		return normalizePromptError(err)
	}
	prompted = prompted || agentPrompted

	if prompted {
		ok, err := promptInstallConfirmation(skills, s, resolvedAgents)
		if err != nil {
			return normalizePromptError(err)
		}
		if !ok {
			fmt.Println("Cancelled.")
			return nil
		}
	} else {
		fmt.Printf("Scope: %s\n", s.Identity)
		fmt.Printf("Agents: %s\n", strings.Join(resolvedAgents, ", "))
		fmt.Printf("Skills: %s\n", strings.Join(skills, ", "))
	}

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
	if len(r.Installations) == 0 {
		return errors.New("no installer-managed skill installations found")
	}

	groups, err := matchingUpdateGroups(r, names, scopeRaw, agents)
	if err != nil {
		return err
	}
	if len(groups) == 0 {
		return errors.New("no installations match update filters")
	}

	interactive := isInteractive()
	hasFilters := len(names) > 0 || scopeRaw != "" || len(agents) > 0
	if interactive && !hasFilters {
		selected, err := promptUpdateGroups(groups)
		if err != nil {
			return normalizePromptError(err)
		}
		groups = selected
		ok, err := promptUpdateConfirmation(groups)
		if err != nil {
			return normalizePromptError(err)
		}
		if !ok {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	for _, g := range groups {
		normalized, err := normalizeAgents(g.Agents)
		if err != nil {
			return err
		}
		fmt.Printf("Updating %s at %s for %s\n", g.M.Name, g.S.Identity, strings.Join(normalized, ", "))
		if err := installOne(g.M, g.S, normalized); err != nil {
			return err
		}
	}
	return nil
}

func matchingUpdateGroups(r registry, names []string, scopeRaw string, agents []string) ([]updateGroup, error) {
	nameFilter := stringSet(names)
	agentFilter, err := normalizeAgents(agents)
	if err != nil {
		return nil, err
	}
	agentSet := stringSet(agentFilter)

	var scopeFilter *scope
	if scopeRaw != "" {
		s, err := resolveScope(scopeRaw)
		if err != nil {
			return nil, err
		}
		scopeFilter = &s
	}

	groups := map[string]*updateGroup{}
	for _, rec := range r.Installations {
		if len(nameFilter) > 0 && !nameFilter[strings.ToLower(rec.Skill)] {
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
			return nil, err
		}
		key := rec.Skill + "\x00" + rec.Scope.Kind + "\x00" + rec.Scope.Identity
		g := groups[key]
		if g == nil {
			g = &updateGroup{M: m, S: rec.Scope}
			groups[key] = g
		}
		g.Agents = append(g.Agents, rec.Agent)
	}

	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([]updateGroup, 0, len(keys))
	for _, k := range keys {
		g := groups[k]
		normalized, err := normalizeAgents(g.Agents)
		if err != nil {
			return nil, err
		}
		g.Agents = normalized
		out = append(out, *g)
	}
	return out, nil
}

func catalogManifests() ([]manifest, error) {
	entries, err := fs.ReadDir(catalog, "skills")
	if err != nil {
		return nil, err
	}
	var out []manifest
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		m, err := loadManifest(entry.Name())
		if err != nil {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if len(out) == 0 {
		return nil, errors.New("no skills are available in this build")
	}
	return out, nil
}

func validateSkills(names []string) error {
	seen := map[string]bool{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			return errors.New("empty skill name")
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		if _, err := loadManifest(name); err != nil {
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

func printHelp() {
	fmt.Println(`jl-skill - install agent skills

Usage:
  jl-skill [skills...] --scope user|cwd|PATH [--agent AGENT]...
  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...

Interactive usage:
  jl-skill
  jl-skill map
  jl-skill update

Supported harnesses:
  codex
  claude

Interactive mode uses a keyboard-driven selector. Explicit command-line flags remain
available for scripting and automation. When exactly one supported harness is detected,
it is selected automatically.`)
}

func printUpdateHelp() {
	fmt.Println(`jl-skill update - update installer-managed skill installations

Usage:
  jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...

With no filters on an interactive terminal, jl-skill presents all managed installations
as a multi-select list and asks for confirmation before updating.`)
}

func isInteractive() bool {
	st, err := os.Stdin.Stat()
	return err == nil && (st.Mode()&os.ModeCharDevice) != 0
}

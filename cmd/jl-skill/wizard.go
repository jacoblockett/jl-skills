package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

type wizardOption struct {
	ID   string
	Text string
}

func init() {
	if !stdinInteractive() {
		return
	}
	args := os.Args[1:]
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v" || args[0] == "--help" || args[0] == "-h" || args[0] == "help") {
		return
	}
	if len(args) > 0 && args[0] == "update" {
		p := parseArgs(args[1:])
		if len(p.Skills) == 0 && p.Scope == "" && len(p.Agents) == 0 {
			exitWizard(interactiveUpdate())
		}
		return
	}

	body := args
	if len(body) > 0 && body[0] == "install" {
		body = body[1:]
	}
	p := parseArgs(body)
	if len(args) == 0 || (p.Scope != "\x00missing" && (len(p.Skills) == 0 || strings.TrimSpace(p.Scope) == "")) {
		exitWizard(interactiveInstall(p))
	}
}

func stdinInteractive() bool {
	info, err := os.Stdin.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func exitWizard(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "jl-skill:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func interactiveInstall(p parsed) error {
	reader := bufio.NewReader(os.Stdin)
	manifests, err := loadCatalog()
	if err != nil {
		return err
	}

	if len(p.Skills) == 0 {
		names := make([]string, 0, len(manifests))
		for name := range manifests {
			names = append(names, name)
		}
		sort.Strings(names)
		options := make([]wizardOption, 0, len(names))
		for _, name := range names {
			m := manifests[name]
			text := name
			if m.Description != "" {
				text += " - " + m.Description
			}
			options = append(options, wizardOption{ID: name, Text: text})
		}
		defaults := []string{}
		if len(names) == 1 {
			defaults = []string{names[0]}
		}
		p.Skills, err = promptMulti(reader, "Which skills do you want to install?", options, defaults)
		if err != nil {
			return err
		}
	}
	for _, name := range p.Skills {
		if _, ok := manifests[name]; !ok {
			return fmt.Errorf("unknown skill %q", name)
		}
	}

	if strings.TrimSpace(p.Scope) == "" {
		p.Scope, err = promptScope(reader)
		if err != nil {
			return err
		}
	}
	target, err := resolveScope(p.Scope)
	if err != nil {
		return err
	}

	if len(p.Agents) == 0 {
		options := make([]wizardOption, 0, len(agents))
		defaults := []string{}
		for _, spec := range agents {
			detected := harnessDetected(spec)
			text := spec.ID
			if detected {
				text += " (detected)"
				defaults = append(defaults, spec.ID)
			} else {
				text += " (not detected)"
			}
			options = append(options, wizardOption{ID: spec.ID, Text: text})
		}
		p.Agents, err = promptMulti(reader, "Which AI harnesses should receive the skill?", options, defaults)
		if err != nil {
			return err
		}
	} else {
		p.Agents, err = normalizeAgents(p.Agents)
		if err != nil {
			return err
		}
	}

	fmt.Println()
	fmt.Println("Planned installation")
	fmt.Println("  Skills:   ", strings.Join(p.Skills, ", "))
	fmt.Println("  Harnesses:", strings.Join(p.Agents, ", "))
	fmt.Println("  Scope:    ", target.Identity)
	fmt.Println("  Map state: not initialized by installer")
	ok, err := promptConfirm(reader, "Continue?", true)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("operation cancelled")
	}
	fmt.Println()
	return install(p)
}

func interactiveUpdate() error {
	reader := bufio.NewReader(os.Stdin)
	manifests, err := loadCatalog()
	if err != nil {
		return err
	}
	reg, err := loadRegistry()
	if err != nil {
		return err
	}
	if len(reg.Installations) == 0 {
		return errors.New("no installer-managed installations found")
	}

	type candidate struct {
		key string
		r   receipt
	}
	candidates := make([]candidate, 0, len(reg.Installations))
	for i, r := range reg.Installations {
		key := strconv.Itoa(i + 1)
		candidates = append(candidates, candidate{key: key, r: r})
	}
	options := make([]wizardOption, 0, len(candidates))
	defaults := make([]string, 0, len(candidates))
	for _, c := range candidates {
		options = append(options, wizardOption{
			ID:   c.key,
			Text: fmt.Sprintf("%s at %s [%s]", c.r.Skill, c.r.Scope.Identity, c.r.Agent),
		})
		defaults = append(defaults, c.key)
	}
	selected, err := promptMulti(reader, "Which installations should be updated?", options, defaults)
	if err != nil {
		return err
	}
	selectedSet := stringSet(selected)

	type group struct {
		m      manifest
		scope  scope
		agents []string
	}
	groups := map[string]*group{}
	for _, c := range candidates {
		if !selectedSet[c.key] {
			continue
		}
		m, ok := manifests[c.r.Skill]
		if !ok {
			return fmt.Errorf("installed skill %q is not in this catalog", c.r.Skill)
		}
		key := c.r.Skill + "\x00" + c.r.Scope.Kind + "\x00" + c.r.Scope.Identity
		g := groups[key]
		if g == nil {
			g = &group{m: m, scope: c.r.Scope}
			groups[key] = g
		}
		if !contains(g.agents, c.r.Agent) {
			g.agents = append(g.agents, c.r.Agent)
		}
	}
	if len(groups) == 0 {
		return errors.New("no installations selected")
	}

	fmt.Println()
	fmt.Println("Planned updates")
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		g := groups[key]
		sort.Strings(g.agents)
		fmt.Printf("  %s at %s [%s]\n", g.m.Name, g.scope.Identity, strings.Join(g.agents, ", "))
	}
	ok, err := promptConfirm(reader, "Continue?", true)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("operation cancelled")
	}
	fmt.Println()
	for _, key := range keys {
		g := groups[key]
		fmt.Printf("Updating %s at %s for %s\n", g.m.Name, g.scope.Identity, strings.Join(g.agents, ", "))
		if err := installOne(g.m, g.scope, g.agents); err != nil {
			return err
		}
	}
	return nil
}

func promptScope(reader *bufio.Reader) (string, error) {
	for {
		fmt.Println()
		fmt.Println("Where should the selected skills be installed?")
		fmt.Println("  1) Current directory")
		fmt.Println("  2) User")
		fmt.Println("  3) Custom path")
		value, err := promptLine(reader, "Choice", "1")
		if err != nil {
			return "", err
		}
		switch strings.ToLower(value) {
		case "1", "cwd", "current", "current directory":
			return "cwd", nil
		case "2", "user":
			return "user", nil
		case "3", "custom", "path":
			path, err := promptLine(reader, "Custom path", "")
			if err != nil {
				return "", err
			}
			if strings.TrimSpace(path) != "" {
				return path, nil
			}
		default:
			fmt.Println("Invalid choice.")
		}
	}
}

func promptMulti(reader *bufio.Reader, message string, options []wizardOption, defaults []string) ([]string, error) {
	if len(options) == 0 {
		return nil, errors.New("no choices available")
	}
	defaultSet := stringSet(defaults)
	for {
		fmt.Println()
		fmt.Println(message)
		for i, option := range options {
			mark := " "
			if defaultSet[option.ID] {
				mark = "*"
			}
			fmt.Printf("  %d) [%s] %s\n", i+1, mark, option.Text)
		}
		value, err := promptLine(reader, "Select comma-separated numbers/names; Enter accepts *", "")
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(value) == "" {
			if len(defaults) > 0 {
				return uniqueSorted(defaults), nil
			}
			fmt.Println("Select at least one option.")
			continue
		}
		selected := map[string]bool{}
		valid := true
		for _, token := range strings.Split(value, ",") {
			token = strings.TrimSpace(token)
			if token == "" {
				continue
			}
			matched := ""
			if index, err := strconv.Atoi(token); err == nil && index >= 1 && index <= len(options) {
				matched = options[index-1].ID
			} else {
				for _, option := range options {
					if strings.EqualFold(token, option.ID) {
						matched = option.ID
						break
					}
				}
			}
			if matched == "" {
				valid = false
				fmt.Printf("Unknown selection %q.\n", token)
				break
			}
			selected[matched] = true
		}
		if !valid || len(selected) == 0 {
			continue
		}
		out := make([]string, 0, len(selected))
		for id := range selected {
			out = append(out, id)
		}
		sort.Strings(out)
		return out, nil
	}
}

func promptConfirm(reader *bufio.Reader, message string, defaultYes bool) (bool, error) {
	defaultText := "y"
	if !defaultYes {
		defaultText = "n"
	}
	for {
		value, err := promptLine(reader, message+" [y/n]", defaultText)
		if err != nil {
			return false, err
		}
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		default:
			fmt.Println("Enter y or n.")
		}
	}
}

func promptLine(reader *bufio.Reader, label, defaultValue string) (string, error) {
	if defaultValue != "" {
		fmt.Printf("%s [%s]: ", label, defaultValue)
	} else {
		fmt.Printf("%s: ", label)
	}
	value, err := reader.ReadString('\n')
	if err != nil && len(value) == 0 {
		return "", err
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultValue, nil
	}
	return value, nil
}

func uniqueSorted(values []string) []string {
	set := stringSet(values)
	out := make([]string, 0, len(set))
	for value := range set {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

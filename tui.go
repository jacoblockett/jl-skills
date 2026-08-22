package main

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/charmbracelet/huh"
)

func promptSkills() ([]string, error) {
	manifests, err := catalogManifests()
	if err != nil {
		return nil, err
	}
	options := make([]huh.Option[string], 0, len(manifests))
	for _, m := range manifests {
		label := m.Name
		if strings.TrimSpace(m.Description) != "" {
			label += "  " + strings.TrimSpace(m.Description)
		}
		options = append(options, huh.NewOption(label, m.Name))
	}
	var chosen []string
	field := huh.NewMultiSelect[string]().
		Title("Skills to install").
		Description("Use ↑/↓ to move, space to toggle, enter to continue.").
		Options(options...).
		Validate(requireSelection("select at least one skill")).
		Value(&chosen)
	if err := field.Run(); err != nil {
		return nil, err
	}
	sort.Strings(chosen)
	return chosen, nil
}

func promptScope() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	choice := "cwd"
	field := huh.NewSelect[string]().
		Title("Install scope").
		Description("Choose where this installation should live.").
		Options(
			huh.NewOption("Current directory  "+cwd, "cwd"),
			huh.NewOption("User", "user"),
			huh.NewOption("Custom path", "custom"),
		).
		Value(&choice)
	if err := field.Run(); err != nil {
		return "", err
	}
	if choice != "custom" {
		return choice, nil
	}

	var custom string
	input := huh.NewInput().
		Title("Custom project path").
		Description("Absolute or relative paths are accepted.").
		Placeholder(cwd).
		Validate(func(s string) error {
			if strings.TrimSpace(s) == "" {
				return errors.New("path is required")
			}
			return nil
		}).
		Value(&custom)
	if err := input.Run(); err != nil {
		return "", err
	}
	return strings.TrimSpace(custom), nil
}

func chooseAgents(explicit []string, interactive bool) ([]string, bool, error) {
	if len(explicit) > 0 {
		normalized, err := normalizeAgents(explicit)
		return normalized, false, err
	}

	detected := detectedAgents()
	switch len(detected) {
	case 0:
		if !interactive {
			return nil, false, errors.New("no supported AI harness detected; use --agent explicitly")
		}
		chosen, err := promptAgents(nil)
		return chosen, true, err
	case 1:
		return detected, false, nil
	default:
		if !interactive {
			return detected, false, nil
		}
		chosen, err := promptAgents(detected)
		return chosen, true, err
	}
}

func promptAgents(detected []string) ([]string, error) {
	detectedSet := stringSet(detected)
	options := make([]huh.Option[string], 0, len(agentCatalog))
	for _, spec := range agentCatalog {
		label := spec.Label
		if detectedSet[spec.ID] {
			label += "  detected"
		}
		opt := huh.NewOption(label, spec.ID)
		if detectedSet[spec.ID] {
			opt = opt.Selected(true)
		}
		options = append(options, opt)
	}

	description := "Use ↑/↓ to move, space to toggle, enter to continue."
	if len(detected) == 0 {
		description = "No supported harness was detected automatically. Select the harnesses to target."
	}

	var chosen []string
	field := huh.NewMultiSelect[string]().
		Title("Target harnesses").
		Description(description).
		Options(options...).
		Validate(requireSelection("select at least one harness")).
		Value(&chosen)
	if err := field.Run(); err != nil {
		return nil, err
	}
	return normalizeAgents(chosen)
}

func promptInstallConfirmation(skills []string, s scope, agents []string) (bool, error) {
	confirmed := true
	description := fmt.Sprintf(
		"Skills: %s\nHarnesses: %s\nScope: %s",
		strings.Join(skills, ", "),
		strings.Join(agentLabels(agents), ", "),
		s.Identity,
	)
	field := huh.NewConfirm().
		Title("Install?").
		Description(description).
		Affirmative("Install").
		Negative("Cancel").
		Value(&confirmed)
	if err := field.Run(); err != nil {
		return false, err
	}
	return confirmed, nil
}

func promptUpdateGroups(groups []updateGroup) ([]updateGroup, error) {
	options := make([]huh.Option[int], 0, len(groups))
	for i, g := range groups {
		label := fmt.Sprintf("%s  %s  [%s]", g.M.Name, g.S.Identity, strings.Join(agentLabels(g.Agents), ", "))
		options = append(options, huh.NewOption(label, i).Selected(true))
	}
	var chosen []int
	field := huh.NewMultiSelect[int]().
		Title("Installations to update").
		Description("All installer-managed installations are selected by default.").
		Options(options...).
		Validate(func(v []int) error {
			if len(v) == 0 {
				return errors.New("select at least one installation")
			}
			return nil
		}).
		Value(&chosen)
	if err := field.Run(); err != nil {
		return nil, err
	}
	sort.Ints(chosen)
	out := make([]updateGroup, 0, len(chosen))
	for _, idx := range chosen {
		if idx < 0 || idx >= len(groups) {
			return nil, errors.New("invalid update selection")
		}
		out = append(out, groups[idx])
	}
	return out, nil
}

func promptUpdateConfirmation(groups []updateGroup) (bool, error) {
	confirmed := true
	lines := make([]string, 0, len(groups))
	for _, g := range groups {
		lines = append(lines, fmt.Sprintf("%s at %s [%s]", g.M.Name, g.S.Identity, strings.Join(agentLabels(g.Agents), ", ")))
	}
	field := huh.NewConfirm().
		Title("Update selected installations?").
		Description(strings.Join(lines, "\n")).
		Affirmative("Update").
		Negative("Cancel").
		Value(&confirmed)
	if err := field.Run(); err != nil {
		return false, err
	}
	return confirmed, nil
}

func requireSelection(message string) func([]string) error {
	return func(items []string) error {
		if len(items) == 0 {
			return errors.New(message)
		}
		return nil
	}
}

func normalizePromptError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, huh.ErrUserAborted) {
		return errors.New("cancelled")
	}
	return err
}

func agentLabels(ids []string) []string {
	byID := map[string]string{}
	for _, spec := range agentCatalog {
		byID[spec.ID] = spec.Label
	}
	labels := make([]string, 0, len(ids))
	for _, id := range ids {
		if label := byID[id]; label != "" {
			labels = append(labels, label)
		} else {
			labels = append(labels, id)
		}
	}
	return labels
}

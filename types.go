package main

import (
	"sort"
	"strings"
	"time"
)

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

type agentSpec struct {
	ID      string
	Label   string
	Command string
	Marker  string
}

var agentCatalog = []agentSpec{
	{ID: "codex", Label: "OpenAI Codex", Command: "codex", Marker: ".codex"},
	{ID: "claude", Label: "Claude Code", Command: "claude", Marker: ".claude"},
}

type updateGroup struct {
	M      manifest
	S      scope
	Agents []string
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
			return nil, fmtErrorUnsupportedAgent(item)
		}
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	sort.Strings(out)
	return out, nil
}

func fmtErrorUnsupportedAgent(agent string) error {
	return &unsupportedAgentError{agent: agent}
}

type unsupportedAgentError struct{ agent string }

func (e *unsupportedAgentError) Error() string { return "unsupported agent \"" + e.agent + "\"" }

func stringSet(items []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range items {
		m[strings.ToLower(strings.TrimSpace(x))] = true
	}
	return m
}

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

type manifest struct {
	Name                string            `json:"name"`
	Version             string            `json:"version"`
	SkillFiles          []string          `json:"skill_files"`
	RuntimeFiles        []string          `json:"runtime_files"`
	Runtime             string            `json:"runtime"`
	RuntimeArtifacts    map[string]string `json:"runtime_artifacts"`
	RuntimeCLI          string            `json:"runtime_cli"`
	InstructionFragment string            `json:"instruction_fragment"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "build:", err)
		os.Exit(1)
	}
}

func run() error {
	repo, err := os.Getwd()
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(repo, "go.mod")); err != nil {
		return fmt.Errorf("run from jl-skills repository root: %w", err)
	}
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return fmt.Errorf("current installer build supports Windows x64 only")
	}

	buildDir := filepath.Join(repo, "build")
	stageRoot := filepath.Join(repo, "internal", "catalog", "assets", "catalog")
	if err := os.RemoveAll(stageRoot); err != nil {
		return err
	}
	if err := os.MkdirAll(stageRoot, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		return err
	}

	entries, err := os.ReadDir(filepath.Join(repo, "skills"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		skillRoot := filepath.Join(repo, "skills", entry.Name())
		manifestPath := filepath.Join(skillRoot, "jl-skill.json")
		data, err := os.ReadFile(manifestPath)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var m manifest
		if err := json.Unmarshal(data, &m); err != nil {
			return fmt.Errorf("parse %s: %w", manifestPath, err)
		}
		if m.Name == "" || m.Version == "" {
			return fmt.Errorf("invalid manifest %s", manifestPath)
		}

		destRoot := filepath.Join(stageRoot, m.Name)
		if err := os.MkdirAll(destRoot, 0o755); err != nil {
			return err
		}
		if err := copyFile(manifestPath, filepath.Join(destRoot, "jl-skill.json")); err != nil {
			return err
		}

		declared := append([]string{}, m.SkillFiles...)
		declared = append(declared, m.RuntimeFiles...)
		if m.InstructionFragment != "" {
			declared = append(declared, m.InstructionFragment)
		}
		seen := map[string]bool{}
		for _, rel := range declared {
			if rel == "" || seen[rel] {
				continue
			}
			seen[rel] = true
			if err := copyPath(filepath.Join(skillRoot, filepath.FromSlash(rel)), filepath.Join(destRoot, filepath.FromSlash(rel))); err != nil {
				return fmt.Errorf("stage %s/%s: %w", m.Name, rel, err)
			}
		}

		if m.Runtime == "rust" {
			if err := buildRustRuntime(repo, skillRoot, buildDir, destRoot, m); err != nil {
				return err
			}
		} else if m.Runtime != "" {
			return fmt.Errorf("unsupported runtime %q for %s", m.Runtime, m.Name)
		}
	}

	out := filepath.Join(buildDir, "jl-skill.exe")
	cmd := exec.Command("go", "build", "-trimpath", "-o", out, "./cmd/jl-skill")
	cmd.Dir = repo
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("build jl-skill.exe: %w", err)
	}
	fmt.Println("Built", out)
	return nil
}

func buildRustRuntime(repo, skillRoot, buildDir, destRoot string, m manifest) error {
	cargo, err := exec.LookPath("cargo")
	if err != nil {
		return fmt.Errorf("cargo is required to build %s runtime", m.Name)
	}
	artifactRel := m.RuntimeArtifacts["windows-x64"]
	if artifactRel == "" {
		return fmt.Errorf("%s manifest has no windows-x64 runtime artifact", m.Name)
	}
	if m.RuntimeCLI == "" {
		return fmt.Errorf("%s manifest is missing runtime_cli", m.Name)
	}
	targetDir := filepath.Join(buildDir, "cargo", m.Name)
	cmd := exec.Command(cargo,
		"build",
		"--manifest-path", filepath.Join(skillRoot, "Cargo.toml"),
		"--release",
		"--target-dir", targetDir,
	)
	cmd.Dir = repo
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("build %s runtime: %w", m.Name, err)
	}
	source := filepath.Join(targetDir, "release", m.RuntimeCLI+".exe")
	dest := filepath.Join(destRoot, filepath.FromSlash(artifactRel))
	if err := copyFile(source, dest); err != nil {
		return fmt.Errorf("stage %s runtime: %w", m.Name, err)
	}
	return nil
}

func copyPath(source, dest string) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return copyFile(source, dest)
	}
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

func copyFile(source, dest string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

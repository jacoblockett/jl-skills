package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

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

	if err := os.RemoveAll(filepath.Join(runtimeRoot, "site-packages")); err != nil {
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

func cmdArg(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func shArg(s string) string  { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

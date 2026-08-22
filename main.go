package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"os"
)

//go:embed skills/**
var catalog embed.FS

const version = "0.2.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "jl-skill-core:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 1 {
		switch args[0] {
		case "--version", "-v":
			fmt.Printf("jl-skill-core %s\n", version)
			return nil
		case "__catalog":
			items, err := catalogManifests()
			if err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(items)
		case "__agents":
			detected := stringSet(detectedAgents())
			items := make([]map[string]any, 0, len(agentCatalog))
			for _, spec := range agentCatalog {
				items = append(items, map[string]any{
					"id":       spec.ID,
					"label":    spec.Label,
					"detected": detected[spec.ID],
				})
			}
			return json.NewEncoder(os.Stdout).Encode(items)
		case "__registry":
			r, err := loadRegistry()
			if err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(r)
		}
	}
	if len(args) > 0 && args[0] == "update" {
		return runUpdate(args[1:])
	}
	return runInstall(args)
}

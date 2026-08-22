package main

import (
	"embed"
	"fmt"
	"os"
)

//go:embed skills/**
var catalog embed.FS

const version = "0.1.0-dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "jl-skill:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Println(version)
		return nil
	}
	if len(args) > 0 && args[0] == "update" {
		return runUpdate(args[1:])
	}
	return runInstall(args)
}

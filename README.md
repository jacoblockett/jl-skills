# JLS

JLS is a cross-platform installer and manager for AI coding-agent skills. It provides one interface for installing, updating, and removing skills across supported agent harnesses without requiring users to manually place files, runtimes, or agent resources.

## Features

- Install and update skills from the JLS catalog.
- Install to your user environment, the current project, or a custom path.
- Configure a skill for one or more supported AI coding agents.
- Optionally add and maintain skill instructions in the agent's instruction file.
- Remove individual skill integrations without disturbing unrelated files.
- Remove skill-generated project data separately when a skill declares it.
- Update or uninstall JLS itself from the interactive interface.

## Supported platforms

JLS provides native builds for:

- Windows x64
- Windows ARM64
- macOS x64
- macOS ARM64
- Linux x64 (GNU)
- Linux ARM64 (GNU)
- Linux x64 (musl)
- Linux ARM64 (musl)

## Supported agents

JLS currently supports:

- OpenAI Codex
- Claude Code

A single skill can be installed for multiple supported agents in the same scope.

## Installation

Download the JLS build for your operating system and architecture from the repository's **Releases** page.

On macOS or Linux, make the downloaded file executable if necessary:

```bash
chmod +x <downloaded-file>
```

Then run it.

## Usage

The primary interface is interactive. Launch JLS with no arguments and choose what you want to do:

```text
jls
```

In the examples below, `jls` means the JLS executable you downloaded.

The interactive interface can:

- install skills;
- update installed skills;
- uninstall skills;
- remove skill-generated data;
- update JLS;
- uninstall JLS.

### Installation scope

When installing, updating, or uninstalling a skill, JLS operates only within the scope you select:

- **User** — installs the skill for your user account.
- **Current directory** — installs the skill for the current project.
- **Custom path** — installs the skill for a specific project or directory you choose.

Project-scoped operations stay inside that project. User-scoped operations use the supported agent's user-level locations.

### Agent integration

During installation, choose the agents that should receive the skill. JLS installs the skill and any agent-specific resources into the locations expected by those agents.

Instruction-file integration is optional. When enabled, JLS manages only its own bounded section of the appropriate instruction file and preserves unrelated content.

## Command-line usage

JLS also supports non-interactive install, update, and uninstall commands.

```text
jls install [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]
jls update [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]
jls uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
```

Supported agent IDs are `codex` and `claude`.

Examples:

```bash
jls install skill-name --scope cwd --agent codex --instructions
jls install skill-name --scope user --agent codex --agent claude
jls update skill-name --scope cwd
jls uninstall skill-name --scope cwd --agent codex
```

When running non-interactively, provide an explicit `--scope`.

## Skill updates and removal

JLS discovers installed skills from the supported agent locations in the selected scope. Updating a skill replaces the files owned by that skill while preserving unrelated project files and separately managed skill-generated data.

Uninstalling a skill removes the selected agent integration. Scope-local tooling shared by another remaining integration for the same skill is retained until the final integration is removed.

Skill-generated data is never automatically deleted as part of an ordinary skill uninstall. Use **Remove skill-generated data** when you explicitly want that data removed.

## Uninstalling JLS

Uninstalling JLS removes the installer and installer-owned data. It does not automatically remove installed skills, their scope-local tooling, or skill-generated project data.

## Development

JLS is built with Bun 1.4.0.

```bash
bun install --frozen-lockfile
bun run build
bun run test:installer
```

`bun run smoke` runs the build and installer test suite together.

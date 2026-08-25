# jl-skill

Status: accepted installer contract aligned to the Bun/Clack implementation and native Map runtime.

## Product goal

`jl-skill` is the user-facing installer/updater for the `jl-skills` catalog. Consumers should not need to know where skill discovery files, harness-specific resources, runtimes, instruction fragments, or support assets belong.

The public distribution target is one self-contained executable such as `jl-skill.exe`. A consumer machine should need only the AI harness(es) the user intends to target. Consumers must not need Python, Node, npm, pnpm, Bun, Go, Rust, Cargo, or a SurrealDB server merely to install/use a released skill.

Build dependencies belong only to development/release infrastructure, never consumer machines. The current canonical development and smoke-build path is local on the release/developer machine. GitHub Actions is not required by the product contract and may be reintroduced later only if useful.

## Installer implementation

`jl-skill` is implemented as one **TypeScript + Bun** codebase.

The interactive installer uses exactly **`@clack/prompts` 1.7.0**, matching the accepted create-vite prompt stack. This is a product requirement, not an implementation suggestion. Do not replace it with line-oriented numbered menus, `fmt.Scanln`, Huh, Bubble Tea, survey, or another lookalike TUI.

Release compilation uses:

```text
Bun --compile -> jl-skill.exe
```

Do not introduce a Go installer core, Node SEA packaging layer, or a second runtime boundary unless the contract is explicitly changed.

## Interactive UX contract

Use Clack controls according to the choice being made:

- `multiselect` for skills, harnesses, and update targets;
- `select` for mutually exclusive scope choices;
- `text` only for inherently free-form input such as a custom path;
- `confirm` for final confirmation;
- Clack `intro` / `note` / `outro` presentation for plan and completion state.

Bare `jl-skill` starts the install wizard. Bare `jl-skill update` starts the update wizard. Incomplete interactive invocations fill only missing choices. Explicit complete CLI invocations remain deterministic and do not add unnecessary prompts.

## Public CLI

```text
jl-skill [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
```

Examples:

```bash
jl-skill.exe map --scope user
jl-skill.exe map --scope cwd
jl-skill.exe map --scope "C:\Programming\my-project"
jl-skill.exe map --scope cwd --agent codex
jl-skill.exe map --scope cwd --agent codex --agent claude
jl-skill.exe update map --scope user
```

`--agent` is repeatable. If omitted on an otherwise explicit non-interactive install, select all detected supported harnesses. If none are detected, fail precisely and tell the user to specify `--agent`.

## Hard scope invariant

Scope and harness selection are orthogonal:

```text
WHERE?  --scope user|cwd|PATH
WHO?    detected/default harnesses or explicit --agent values
```

The requested scope is authoritative. Harness detection determines available adapters; it must never widen, relocate, or duplicate installation into another scope.

For `jl-skill.exe map --scope cwd`, detection of a user-installed Codex or Claude only permits those harnesses to be targeted at the current project. It does not authorize user-scope skill copies or instruction injection.

The only permitted user-level data for a project/path install is installer-owned bookkeeping and explicitly declared narrow scope-independent support artifacts. Neither may make the skill discoverable at user scope or inject user-scope instructions. Map's shared CLI and schema are such support artifacts.

## Scope semantics

`--scope` accepts exactly one value: `user`, `cwd`, or a path string.

`user` and `cwd` are reserved logical tokens. A literal directory with either name must be expressed unambiguously, e.g. `./user`.

`cwd` resolves to the invocation working directory. Explicit paths normalize `~`, supported environment variables, relative components, separators, and `.`/`..`; they become absolute/canonical where safely available while preserving Windows drive/UNC semantics.

The target may be completely uninitialized. The installer recursively creates the requested target path when needed, then creates only the non-semantic structures required for discovery, harness resources, managed instructions, runtime placement, and declared support assets.

## Harness adapters

Supported harnesses initially include Codex and Claude.

Each adapter owns machine detection, user/project discovery paths, skill-resource placement, custom agent/subagent placement when declared, instruction-file conventions, validation, and future migration behavior.

Detection is not permission to change scope. If a harness cannot support the requested scope/resource type, report that limitation; never silently fall back.

## Managed instruction integration

The generic installer owns instruction-file lifecycle. Skills declare fragments instead of appending arbitrary prose themselves.

Managed content uses deterministic markers such as:

```md
<!-- jl-skill:begin map -->
...installer-owned Map instructions...
<!-- jl-skill:end map -->
```

Required behavior:

- preserve unmanaged/user-authored content;
- create files only when needed;
- repeated install/update is idempotent;
- update only the matching owned block;
- allow independent blocks from multiple skills;
- use safe/atomic writes;
- reject malformed/duplicate/conflicting markers rather than guessing;
- clearly identify the interior as installer-managed content;
- future uninstall removes only installer-owned content.

Instruction fragments should give ordinary agents enough immediately useful CLI guidance to operate safely without reproducing the full skill manual. Map's fragment includes a short set of common read-only commands plus `--help` / `<command> --help` discovery and must render the actual installer-provisioned CLI path rather than assuming `map` is on `PATH`.

Instruction integration always follows requested scope.

## Package model

Installation is manifest-driven. A package may declare name/version/description, skill resources, runtime kind, platform runtime artifacts, runtime support files, a scope-independent CLI destination, scope-independent support artifacts, harness agent/subagent resources, instruction fragment, supported scopes/capabilities, validation, and migration metadata.

A manifest-declared scope-independent CLI destination is support infrastructure, not skill discovery. Its presence must not cause user-scope skill copies or user-scope instruction injection for a project/path install.

Harness filesystem knowledge belongs in adapters, not every skill package. Semantic project initialization is not an installer hook.

## Build and release pipeline

The current Windows x64 build/smoke pipeline is local and conceptually:

```text
Map Rust source
  -> cargo test
  -> cargo build --release
  -> map.exe

TypeScript installer + @clack/prompts
  + package catalog / prebuilt payload references
  -> Bun --compile
  -> jl-skill.exe

local smoke test
  -> run compiled jl-skill.exe in isolated fake homes/projects
  -> exercise cwd, user, and explicit-path scope
  -> assert installer did not create or mutate .map
  -> assert skill/support/instruction files exist at the requested scope
  -> assert existing instruction content is preserved and managed blocks are idempotent
  -> assert malformed managed boundaries reject rather than guess
  -> assert user-scope installation preserves unrelated harness/user files
  -> assert Map CLI is ~/.jl-skills/map/bin/map.exe for every scope
  -> run installed map.exe against preserved/new Map state
```

A release builder may have Bun, Rust, Cargo, and other build dependencies installed. Those dependencies remain completely outside the consumer contract.

The checked-in Windows regression entry point is:

```bash
bun run smoke
```

## Package transport

The public consumer model is one downloaded `jl-skill.exe`. The installer resolves selected skills and installs **already-built** skill/runtime payloads. It never compiles a skill on the consumer machine.

Package acquisition/transport must remain separable from installation semantics. Public distribution should fetch versioned prebuilt payloads from a release endpoint accessible to the standalone installer.

While `jl-skills` is private, a development smoke build may embed the exact prebuilt payload so the standalone EXE can be exercised without requiring private GitHub credentials. That is a temporary transport convenience only. It must not alter scope, harness placement, receipts, runtime paths, or the zero-toolchain consumer contract.

## Map runtime

Map is a native Rust CLI application backed by embedded **SurrealKV** through the pinned SurrealDB/SurrealKV storage stack.

For Windows x64:

```text
Map Rust source
  -> release map.exe
  -> prebuilt package payload
  -> ~/.jl-skills/map/bin/map.exe
```

The Map CLI destination is deliberately scope-independent. User, cwd, and explicit-path installs all provision/update the same executable:

```text
~/.jl-skills/map/bin/map.exe
```

The shared default schema lives at:

```text
~/.jl-skills/map/schema.surql
```

There is no SurrealDB daemon/listening port. The runtime owns embedded database access directly.

The shared executable and schema do not widen harness discovery or instruction scope and do not create authoritative semantic state. Project `.map/` state remains project-local and runtime-owned.

## Installation responsibilities

For an install request, `jl-skill` should:

1. resolve requested skill packages and versions;
2. parse/normalize scope;
3. detect supported harnesses;
4. resolve selected harnesses from defaults or explicit flags;
5. acquire already-built package payloads;
6. compute the skill × harness plan at the requested scope only;
7. show/confirm that plan in interactive mode;
8. create only required non-semantic structures;
9. install skill discovery/resources and declared harness/subagent resources;
10. provision prebuilt runtime/support assets;
11. update managed instruction blocks;
12. validate selected harness targets;
13. write/update installer receipts;
14. report exact per-target results.

Re-running an identical install must converge without duplicate skills, instructions, runtimes, or receipts. A selected-target failure must remain visible and produce a failing overall exit status.

## Registry and update

Use an OS-appropriate installer-owned registry with at least skill/version, normalized scope identity, harness adapter, managed skill/runtime paths, instruction ownership, timestamp, and source/catalog identity when available.

This bookkeeping must not make a project-scoped skill globally discoverable. Missing recorded resources are stale/missing installations, not permission to recreate elsewhere.

`update` uses the same manifest/adapter machinery, never relocates an installation's discovery/instruction scope, preserves unrelated content, and may update owned skill files, harness resources, shared or scope-local runtimes, support assets, managed instructions, receipts, and migrations.

Bare interactive `jl-skill update` uses Clack multiselect to choose installer-managed installations before confirmation.

## Map-specific contract

Installing Map installs/configures the skill, prebuilt native runtime, declared support assets, managed ordinary-agent instructions, and declared Map harness/subagent resources.

Map always provisions its CLI to:

```text
~/.jl-skills/map/bin/map.exe
```

Installing Map must **not**:

- create `.map/`;
- create/open an embedded Map database;
- invoke `map init`;
- apply the Map schema to project semantic state;
- create semantic nodes/relations;
- create a recovery session;
- overwrite unrelated user/project harness configuration or unmanaged instruction content.

Map state is runtime-owned. Explicit `map init` creates `.map` only when Map is actually started for a target project. A user-scope skill install therefore makes Map available across projects but never creates one global authoritative graph.

The default schema and shared CLI are scope-independent runtime support artifacts; installing them is not project-state initialization.

## Deferred commands

`list`, `status`, `repair`, and `uninstall` may follow. Ownership/registry design must remain sufficient to add them without replacing the installation model.

## Non-goals

- marketplace/account system;
- arbitrary untrusted third-party hooks;
- universal environment manager;
- elaborate GUI;
- silently modifying unknown harnesses;
- per-skill bespoke installers where a manifest suffices;
- treating harness detection as permission to widen scope;
- installer-created semantic project state;
- consumer-side compilation;
- replacing the accepted Vite/Clack interactive UX with another TUI library.

# jl-skill

Status: accepted installer contract aligned to the Bun/Clack implementation and native Map runtime.

## Product goal

`jl-skill` is the user-facing installer, updater, and uninstaller for the `jl-skills` catalog. Consumers should not need to know where skill discovery files, harness-specific resources, runtimes, instruction fragments, or support assets belong.

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

## Public CLI

Primary deterministic forms:

```text
jl-skill install [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
jl-skill update [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
jl-skill uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
```

For compatibility/convenience, an invocation beginning directly with skill names may continue to mean install:

```text
jl-skill map --scope cwd
```

Examples:

```bash
jl-skill.exe install map --scope user
jl-skill.exe install map --scope cwd
jl-skill.exe install map --scope "C:\Programming\my-project"
jl-skill.exe install map --scope cwd --agent codex
jl-skill.exe update map --scope user
jl-skill.exe uninstall map --scope cwd
```

`--agent` is repeatable. Complete explicit commands are deterministic and do not add unnecessary prompts. Incomplete interactive commands prompt only for missing choices.

## Hard scope invariant

Scope and harness selection are orthogonal:

```text
WHERE?  --scope user|cwd|PATH
WHO?    detected/default harnesses or explicit --agent values
```

The requested scope is authoritative. Harness detection determines available adapters; it must never widen, relocate, or duplicate installation into another scope.

For a project/path install, detection of a user-installed Codex or Claude permits those harnesses to be targeted only at the requested project. It does not authorize user-scope skill copies or user-scope instruction injection.

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

## Interactive UX contract

Use Clack controls according to the choice being made:

- `select` for mutually exclusive choices;
- `multiselect` for skill/harness sets;
- `text` only for inherently free-form input such as a custom path;
- `confirm` for final confirmation;
- Clack `intro` / `note` / `outro` presentation for plan and completion state.

Every interactive decision path must offer a clear **Cancel** choice within reason. Cancellation before mutation exits without making changes. If a future operation ever must mutate before the form is complete, it must either be safely reversible on cancellation or explicitly document that boundary; the normal installer/update/uninstall flows should not require such early mutation.

### Bare executable

Bare:

```text
jl-skill.exe
```

starts with a top-level single choice:

```text
What would you like to do?

> Manage skills
  Remove JL-Skills from this computer
  Cancel
```

`Manage skills` is the default.

### Manage skills: choose scope first

The next single choice is:

```text
Where would you like to manage skills?

> Current directory
  User
  Custom path
  Cancel
```

Only after resolving that exact scope does the installer inspect its registry for installations at that scope.

If no managed skills are installed there, skip an unnecessary action question and proceed directly to the install-skill multiselect.

If installations exist there, show a compact installed summary and ask:

```text
What would you like to do?

> Install new skills
  Update installed skills
  Uninstall installed skills
  Cancel
```

`Install new skills` is the default.

### Install selection

The install multiselect shows the catalog rather than hiding already-installed skills. Skills already installed at the selected scope are visible but disabled/unselectable with a simple hint such as `already installed`.

Example:

```text
Select skills to install

[ ] Foo
[ ] Bar
[-] Map        (already installed)
[ ] Cancel
```

Nothing is preselected.

Selecting an already-installed skill in the install flow does **not** implicitly become an update. Update remains a distinct action.

### Update selection

The update multiselect contains installed skills plus two sentinel choices:

```text
Select skills to update

[ ] Map
[ ] Foo
[ ] Update all
[ ] Cancel
```

Nothing is preselected.

`Update all` and `Cancel` are exclusive choices. Individual selections clear exclusive choices; `Update all` clears individuals and `Cancel`; `Cancel` clears everything else.

### Uninstall selection

The uninstall multiselect follows the same pattern:

```text
Select skills to uninstall

[ ] Map
[ ] Foo
[ ] Uninstall all
[ ] Cancel
```

Nothing is preselected.

`Uninstall all` and `Cancel` use the same exclusive semantics as update.

### Exclusive multiselect implementation boundary

Clack 1.7.0 does not provide survey-style exclusive options as a first-class `multiselect` feature. JL-Skills should provide a small reusable wrapper around Clack behavior when this can be done without invasive library work.

Required wrapper semantics:

```text
individual selected -> clear All + Cancel
All selected        -> clear individuals + Cancel
Cancel selected     -> clear everything else
```

Do not fork Clack, monkey-patch it, or reproduce a large renderer merely to implement this interaction. If clean live exclusivity proves non-trivial, use ordinary Clack `multiselect` and resolve sentinel choices after submission. If conflicting exclusive choices are submitted, ask a short single-select clarification rather than silently inventing precedence.

### Existing harnesses during update/uninstall

Interactive update/uninstall operates primarily on **skill + scope**. Existing harness receipts for that installation are carried forward rather than asking the user to reconstruct harness selection each time.

The CLI may still permit explicit `--agent` filters for precise automation or removing/updating one harness integration.

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
- uninstall removes only the matching installer-owned content.

Instruction fragments should give ordinary agents enough immediately useful CLI guidance to operate safely without reproducing the full skill manual. Map's fragment includes a short set of common read-only commands plus `--help` / `<command> --help` discovery and must render the actual installer-provisioned CLI path rather than assuming `map` is on `PATH`.

Instruction integration always follows requested scope.

## Package model

Installation is manifest-driven. A package may declare name/version/description, skill resources, runtime kind, platform runtime artifacts, runtime support files, a scope-independent CLI destination, scope-independent support artifacts, harness agent/subagent resources, instruction fragment, supported scopes/capabilities, validation, and migration metadata.

A manifest-declared scope-independent CLI destination is support infrastructure, not skill discovery. Its presence must not cause user-scope skill copies or user-scope instruction injection for a project/path install.

Harness filesystem knowledge belongs in adapters, not every skill package. Semantic project initialization is not an installer hook.

## Installer registry

Use an OS-appropriate installer-owned registry with at least:

- skill and installed version;
- normalized scope identity;
- harness adapter(s);
- managed skill paths;
- managed instruction ownership/path;
- runtime/support paths owned or depended on by the installation;
- timestamp;
- source/catalog identity when available.

This registry is **authoritative for JL-Skills-managed integrations**. Install/update/uninstall may rely on it to determine which integrations JL-Skills owns and where they live.

Manual reconstruction, copying, or modification of installer-owned skill integrations outside JL-Skills is outside the V1 recovery contract. The installer is not required to crawl the filesystem trying to discover unregistered integrations.

If an authoritative receipt points to resources that are now missing, the installation may be reported as incomplete/stale. Update may restore installer-owned resources; uninstall may remove the remaining owned resources and receipt. Missing resources are never permission to recreate the installation at another scope.

The installer registry is separate from any skill-specific registry. In particular, Map owns its own project registry because only `map init` creates Map project state.

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

## Update responsibilities

`update` uses the same manifest/adapter machinery as install.

It must:

- remain at the recorded/requested discovery and instruction scope;
- preserve unrelated user/project content;
- update owned skill files, harness resources, shared/scope-local runtimes, support assets, managed instructions, receipts, and explicit migrations when applicable;
- not initialize or mutate skill semantic project state merely because the skill is updated.

Interactive update does not preselect every installed skill.

## Skill uninstall responsibilities

Normal skill uninstall means **remove the JL-Skills integration at the selected scope**, not erase user project data and not uninstall all of JL-Skills from the machine.

For each selected skill/scope/harness installation, uninstall removes only resources the installer owns there, such as:

- skill discovery/resource files;
- declared harness agent/subagent resources owned by that installation;
- the matching managed instruction block;
- the matching installer receipt.

It preserves:

- unrelated `AGENTS.md`, `CLAUDE.md`, harness configuration, and user files;
- semantic project data such as `.map/`;
- shared `~/.jl-skills/<skill>/...` program/support files unless a separate machine-level removal explicitly removes them.

An identical reinstall after uninstall should behave like a fresh integration install without requiring semantic project recreation.

## Machine-level JL-Skills removal

Machine-level removal is deliberately separate from scoped skill uninstall.

Bare `jl-skill uninstall` without a skill/scope should not silently assume broad destructive intent. If interactive, clarify:

```text
What would you like to uninstall?

> Skills from a project or user installation
  JL-Skills from this computer
  Cancel
```

The machine-removal wizard uses user-accessible wording. Do not expose implementation terms such as `runtime`, `registry`, `bookkeeping`, or `support artifact` as the primary choices.

Primary screen:

```text
Remove JL-Skills from this computer

> Remove JL-Skills but keep my Map project data
  Remove JL-Skills and my Map project data
  Choose what to remove
  Cancel
```

The safe/default choice keeps Map project data.

If the user chooses `Choose what to remove`, present simple choices such as:

```text
Select what to remove

[ ] Skills added to my AI tools
[ ] JL-Skills program files
[ ] Map project data
[ ] Remove everything
[ ] Cancel
```

`Remove everything` and `Cancel` are exclusive sentinel choices under the same rules as other exclusive multiselects.

### Meaning of machine-removal choices

`Skills added to my AI tools` removes installer-owned skill integrations across registered scopes, including skill discovery resources, installer-managed instruction blocks, relevant harness resources, and installation receipts. It does not remove semantic project data.

`JL-Skills program files` removes shared machine-level JL-Skills program/support state such as `~/.jl-skills/map/bin/map.exe`, shared schemas, skill-specific registries, and installer-owned machine bookkeeping after any requested integration cleanup is complete.

`Map project data` removes registered Map `.map/` project data. This is user data and requires an additional explicit destructive confirmation listing the registered project locations that will be affected. Missing locations are reported/skipped rather than guessed or searched for elsewhere.

`Remove everything` means all JL-Skills-installed integrations/program state **and** registered project data, but still requires the same explicit project-data confirmation before deleting `.map/` data.

Machine removal does not recursively crawl all user drives looking for unknown skill state.

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

## Map-specific installer contract

Installing Map installs/configures the skill, prebuilt native runtime, declared support assets, managed ordinary-agent instructions, and declared Map harness/subagent resources.

Installing Map must **not**:

- create `.map/`;
- create/open an embedded Map database;
- invoke `map init`;
- create a Map project-registry entry;
- apply the Map schema to project semantic state;
- create semantic nodes/relations;
- create a recovery session;
- overwrite unrelated user/project harness configuration or unmanaged instruction content.

Map state and Map project registration are runtime-owned. Explicit `map init` creates `.map` and the corresponding Map project-registry entry. A user-scope skill install therefore makes Map available across projects but never creates one global authoritative graph/project.

The default schema and shared CLI are scope-independent runtime support artifacts; installing them is not project-state initialization.

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
  -> exercise install, update, and uninstall lifecycle
  -> assert installer did not create or mutate .map
  -> assert skill/support/instruction files exist at the requested scope
  -> assert existing instruction content is preserved and managed blocks are idempotent
  -> assert malformed managed boundaries reject rather than guess
  -> assert user-scope operations preserve unrelated harness/user files
  -> assert Map CLI is ~/.jl-skills/map/bin/map.exe for every scope
  -> run installed map.exe against preserved/new Map state
```

The checked-in Windows regression entry point remains:

```bash
bun run smoke
```

A release builder may have Bun, Rust, Cargo, and other build dependencies installed. Those dependencies remain completely outside the consumer contract.

## Package transport

The public consumer model is one downloaded `jl-skill.exe`. The installer resolves selected skills and installs **already-built** skill/runtime payloads. It never compiles a skill on the consumer machine.

Package acquisition/transport must remain separable from installation semantics. Public distribution should fetch versioned prebuilt payloads from a release endpoint accessible to the standalone installer.

While `jl-skills` is private, a development smoke build may embed the exact prebuilt payload so the standalone EXE can be exercised without requiring private GitHub credentials. That is a temporary transport convenience only. It must not alter scope, harness placement, receipts, runtime paths, or the zero-toolchain consumer contract.

## Deferred commands/capabilities

`list`, `status`, and dedicated repair tooling may follow. Registry/ownership design must remain sufficient to add them without replacing the installation model.

Do not expand V1 into general filesystem archaeology or automatic recovery of manually reconstructed installer state.

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
- replacing the accepted Vite/Clack interactive UX with another TUI library;
- whole-drive scans to discover unregistered skill projects/integrations;
- automatic deletion of semantic project data during ordinary skill uninstall.
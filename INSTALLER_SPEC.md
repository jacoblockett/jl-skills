# jl-skills installer

Status: accepted installer lifecycle contract aligned to the Bun/Clack implementation and native Map runtime.

## Product goal

`jl-skills` is the user-facing installer, updater, uninstaller, and lifecycle utility for the `jl-skills` catalog. Consumers should not need to know where skill discovery files, harness-specific resources, runtimes, instruction fragments, or support assets belong.

The public distribution target is one self-contained executable:

```text
jl-skills.exe
```

Consumers must not need Python, Node, npm, pnpm, Bun, Go, Rust, Cargo, or a SurrealDB server merely to install or use a released skill.

Build dependencies belong only to development/release infrastructure.

## Installer implementation

The installer is one TypeScript + Bun codebase.

Interactive UI uses exactly:

```text
@clack/prompts 1.7.0
@clack/core    1.4.3
```

The custom controls required by the accepted UX are JL-owned wrappers over Clack core. Do not replace the prompt stack with a different TUI framework, fork Clack, or globally monkey-patch it.

Release compilation is conceptually:

```text
Bun --compile -> jl-skills.exe
```

The product and executable name are always plural: `jl-skills`, never `jl-skill`.

## Public CLI

Primary deterministic forms:

```text
jl-skills install [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]
jl-skills update [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]
jl-skills uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...
```

A skill-first invocation may continue to mean install:

```text
jl-skills map --scope cwd
```

`--agent` is repeatable. Complete explicit commands are deterministic and must not add unnecessary interactive questions.

Interactive-only lifecycle actions such as skill-generated-data removal and installer self-uninstall live on the bare-executable home screen unless a separate deterministic CLI contract is accepted later.

## Hard scope invariant

Scope and harness selection are orthogonal:

```text
WHERE?  --scope user|cwd|PATH
WHO?    selected harnesses / explicit --agent values
```

The requested scope is authoritative. Harness detection or availability must never widen, relocate, or duplicate installation into another scope.

For a project/path install, a machine-level Codex or Claude installation permits those harness adapters to target only the requested project. It does not authorize user-scope skill copies or user-scope instruction injection.

Scope-independent runtime/support artifacts explicitly declared by a skill may still be provisioned at their declared destination. Map's shared CLI and schema are examples. They are support infrastructure, not user-scope skill discovery.

## Scope semantics and path normalization

`--scope` accepts one value:

```text
user
cwd
PATH
```

`user` and `cwd` are reserved logical tokens. A literal directory with one of those names must be expressed as a path such as `./user`.

`cwd` resolves to the invocation working directory.

Explicit paths normalize:

- `~`;
- supported environment variables;
- relative components;
- `.` and `..`;
- Windows separator style;
- Windows drive-letter casing;
- existing filesystem casing where safely available.

The canonicalized path is the value used by the UI whenever a concrete path is displayed. For example, an input such as `c:/programming/example` should display in normalized Windows form such as `C:\Programming\example` where the filesystem can establish that casing.

The target may be uninitialized. Install may create the requested target directory and only the non-semantic structures required for discovery, harness resources, managed instructions, runtime placement, and declared support assets.

## Harness adapters

Initial supported harnesses:

- OpenAI Codex
- Claude Code

Each adapter owns its user/project discovery paths, instruction-file convention, skill-resource placement, and detection logic.

Detection remains internal. Do not put `detected`, `not detected`, `recommended`, or similar status hints on picker options.

No Clack option `hint` is used anywhere unless a future requirement explicitly calls for one specific hint.

## Filesystem-first installation discovery

There is no authoritative central installer receipt registry.

The selected scope's actual harness filesystem state is the source of truth for whether catalog skills are installed there.

For each supported harness at the selected scope, the installer checks the expected skill-discovery location. A catalog skill is recognized from its installed `SKILL.md` and its self-reported jl-skills metadata.

Every catalog skill must self-report enough installed metadata to identify at least:

```text
name
version
metadata format version
```

The current representation is a machine-readable marker in `SKILL.md`, for example:

```html
<!-- jl-skills-meta: {"name":"map","version":"0.2.0","format":1} -->
```

The manifest version and source `SKILL.md` self-report must agree at build/runtime validation time.

This design deliberately permits jl-skills to discover a compatible skill that was copied or installed by another agent instead of requiring that jl-skills itself performed the original installation.

If a recognizable catalog skill exists but usable version metadata is absent or malformed, presence may still be detected, but its installed version is unknown. Never fabricate a version.

## Interactive navigation contract

### Home screen

Bare:

```text
jl-skills.exe
```

starts with:

```text
What would you like to do?

Install skills
Update skills
Uninstall skills
Remove skill-generated data
Uninstall jl-skills installer
```

There is no visible `Cancel & exit` option. Escape performs cancellation.

### Scope questions

After Install:

```text
Where would you like to install skills?
```

After Update:

```text
Where would you like to update skills?
```

After Uninstall:

```text
Where would you like to uninstall skills?
```

Scope choices are:

```text
Current directory
User account
Custom path
```

There are no visible `Go back` or `Cancel & exit` rows. Backspace goes back where a previous interactive step exists. Escape cancels/exits.

Custom-path input is validated. Empty submission must produce a validation message such as `Please provide a path.` rather than throwing. Returning to the custom-path step retains its entered text.

### Selection controls

Multiselect menus contain only substantive choices. Do not add pseudo-options for:

```text
All of the above
Go back
Cancel & exit
```

Accepted keyboard behavior:

```text
↑/↓         navigate
Space       toggle highlighted item
Enter       confirm
A           toggle all selectable normal items
Backspace   go back
Esc         cancel and exit
```

The existing `I` invert-selection behavior may remain undisclosed.

The navigation footer is part of the custom renderer and must visually match native Clack styling. Key/control portions are dimmed while explanatory text and separators remain normal intensity. The guide/spine prefix must remain intact on every footer line.

### Prompt state retention

Wizard state is process-local and explicitly scoped by operation/step identity.

When a user returns to a previously touched step, retain the prior state where still valid:

- single-select cursor/choice;
- multiselect cursor;
- multiselect selected values;
- custom-path text.

Selections that no longer exist or become disabled are discarded rather than restored incorrectly.

State must not bleed between unrelated operations. Install, Update, Uninstall, generated-data removal, and installer-uninstall are distinct state namespaces.

A new jl-skills process starts clean.

Destructive confirmations use their safe default rather than remembering a prior affirmative answer.

### Prompt punctuation

Interactive prompt copy follows ordinary punctuation:

- interrogative questions end in `?`;
- imperative/statement prompts end in `.`;
- headings/note titles do not receive artificial terminal punctuation merely because they are headings.

## Install flow

After scope selection, inspect that scope and present the catalog skill picker.

Already-installed skills remain visible. When a skill cannot be installed again in the selected context, render only the skill name struck through and append a normal, non-struck suffix:

```text
Map (installed)
```

Do not render the entire line struck through and do not use `Map - already installed`.

Nothing is preselected on a never-before-touched install-selection step.

After skill selection, present all supported AI harnesses on one multiselect screen:

```text
Which AI harnesses should receive these skills?
```

Do not insert an intermediate `Choose specific harnesses` question.

Instruction injection is optional. The explanatory note comes first, followed by a concise Yes/No question whose same-line supporting pointer is exactly:

```text
(See above for more information.)
```

The parenthetical is visually dimmed.

### Installation summary

Use a sectioned note with sentence-case headings, simple indentation, comma-delimited compact lists, and newline-delimited locations:

```text
Installation summary

Skills to install
  Map, Other skill

Installation location
  C:\Programming\example

Affected AI harnesses
  OpenAI Codex, Claude Code

Instruction injection
  AGENTS.md, CLAUDE.md
```

If instruction injection is disabled:

```text
Instruction injection
  None
```

No bullet characters are used.

After confirmation, interactive per-target results use Clack's in-flow logging primitive rather than raw `console.log`, preserving the visual spine. Do not repeat an unnecessarily long destination path in each interactive result line when the summary already established the destination.

Non-interactive output may retain concrete paths for automation/debugging.

## Update flow

After selecting scope, discover installed catalog skills directly from the supported harness locations at that scope.

If none are found:

```text
No skills were detected. Choose a different scope or path.
```

Then return to the scope question with its prior cursor retained.

When installations are found, show an in-flow step:

```text
Checking for updates...
```

Compare each installed self-reported version against the bundled catalog version.

Only skills with an actual applicable update are shown in the update multiselect. Up-to-date skills are not offered merely as a repair path in the normal interactive Update flow.

If no updates exist:

```text
No updates found.
```

Then return to the home `What would you like to do?` screen.

Update choices render aligned skill/version columns where practical:

```text
Map       0.2.0 → 0.3.0
Other     1.4.1 → 1.5.0
```

Unknown installed version metadata must be labeled as unknown rather than invented.

Interactive update carries forward the harnesses actually discovered for that skill at the selected scope. Instruction injection state is inferred from whether the installer-managed instruction block currently exists for each discovered harness unless an explicit CLI override is supplied.

Update must not initialize or mutate skill-generated semantic/project data.

## Uninstall flow

After selecting scope, discover installed catalog skills directly from the supported harness locations at that scope.

If none are found, use the same warning:

```text
No skills were detected. Choose a different scope or path.
```

Otherwise show only the installed skills as substantive multiselect choices.

Uninstall removes the selected skill integration from the discovered/explicit harness targets at that scope:

- skill discovery/resource directory;
- matching installer-managed instruction block if present.

It preserves:

- unrelated `AGENTS.md` / `CLAUDE.md` content;
- unrelated harness configuration and user files;
- skill-generated project data such as `.map/`;
- shared skill runtime/tooling such as Map's shared CLI/schema.

The confirmation note follows the same professional sectioned style as the installation summary.

## Managed instruction integration

The installer owns deterministic instruction-block lifecycle, not the surrounding instruction file.

Managed content uses markers such as:

```md
<!-- jl-skill:begin map -->
...managed Map instructions...
<!-- jl-skill:end map -->
```

Required behavior:

- preserve unmanaged/user-authored content;
- create instruction files only when needed;
- repeated install/update is idempotent;
- update only the matching owned block;
- allow independent blocks from multiple skills;
- use safe/atomic writes;
- reject malformed/duplicate/conflicting boundaries rather than guessing;
- uninstall removes only the matching managed block;
- opting out leaves an unrelated existing instruction file untouched.

Instruction fragments must render actual provisioned CLI paths when a skill uses a shared runtime rather than assuming the CLI is on `PATH`.

## Package model

Installation is manifest-driven.

A package may declare:

- name/version/description;
- skill files;
- runtime kind;
- platform runtime artifacts;
- runtime support files;
- scope-independent CLI destination;
- scope-independent support artifacts;
- instruction fragment;
- generated-data locations;
- future harness/subagent resources or migrations when explicitly needed.

Harness filesystem knowledge belongs in adapters, not duplicated in every skill package.

Semantic project initialization is never an installer hook.

## Skill-generated data contract

Skills may declare generated project data in their manifest. Each declaration is a relative path beneath the user-selected scope and may include a narrow marker used to verify that the path is actually that skill's generated data.

Declarations must reject absolute paths and parent traversal (`..`).

Example for Map:

```json
"generated_data": [
  {
    "path": ".map",
    "marker": "project.json"
  }
]
```

### Remove skill-generated data

This is intentionally separate from skill uninstall and installer uninstall.

Flow:

1. `Where would you like to remove skill-generated data?`
2. inspect only that selected scope/path;
3. if none is detected, warn `No skill-generated data was detected. Choose a different scope or path.` and return to scope selection;
4. show only skills whose declared generated data is detected there;
5. ask `Which skills would you like to remove generated data for?`;
6. show the exact generated-data paths in a destructive summary;
7. require an explicit safe-default confirmation;
8. permanently delete only those declared generated-data paths.

Deletion is recursive and unrecoverable. The confirmation must explicitly state that the selected data cannot be recovered.

For Map, selecting Map removes the selected project's `.map` directory. Neighboring project files are untouched.

No registry or whole-drive scan is used to find generated data. The user supplies the scope/path and the installer performs narrow declarative detection there.

## Uninstall jl-skills installer

This action is intentionally installer-only.

It must not uninstall skills, remove skill runtimes/tooling, or remove skill-generated project data.

Before mutation, show an explicit summary containing:

```text
Installer executable
  <exact jl-skills executable path>

Installer-owned data
  <exact installer-owned data path, or None detected.>

Preserved
  Installed skills, skill runtime/tooling, skill-generated data
```

The action is available only from the compiled `jl-skills` executable, not from a development `bun` process that cannot correctly self-delete as the product.

After confirmation:

- remove the installer-owned data directory if present;
- schedule deletion of the running Windows executable after it exits;
- preserve installed skills and their self-reported metadata;
- preserve skill-specific shared support/runtime directories such as `~/.jl-skills/map/...`;
- preserve all generated project data.

Do not describe or delete a nonexistent central installer registry.

## Map runtime integration

Map is a native Rust CLI using embedded SurrealKV through the pinned SurrealDB/SurrealKV stack.

Windows x64 release flow:

```text
Map Rust source
  -> release map.exe
  -> bundled installer payload
  -> ~/.jl-skills/map/bin/map.exe
```

The shared default schema lives at:

```text
~/.jl-skills/map/schema.surql
```

There is no SurrealDB daemon/listening port.

Installing Map must not:

- create `.map/`;
- create/open an embedded project database;
- invoke `map init`;
- create semantic graph nodes/relations;
- create a recovery session;
- overwrite unrelated harness configuration or unmanaged instruction content.

`map init` alone creates Map project state, including the Map-local `.map/project.json` identity metadata.

There is no machine-level Map project registry in the accepted lifecycle.

## Build and smoke pipeline

The current Windows x64 local pipeline is conceptually:

```text
cargo test --release --manifest-path skills/map/Cargo.toml --target-dir build/cargo/map
bun run build
bun run test:installer
```

`bun run smoke` runs that pipeline.

The build produces:

```text
build/jl-skills.exe
```

and removes stale singular `build/jl-skill.exe` output.

The build must validate each catalog skill's source self-report metadata against its manifest before shipping the catalog.

Installer regression coverage should include at least:

- hard scope isolation;
- path normalization;
- self-reported skill metadata installation/discovery;
- manual/filesystem-discovered installation handling;
- instruction injection opt-in/opt-out and managed-block safety;
- update discovery/version comparison;
- uninstall preservation of generated data and shared tooling;
- keyboard multiselect behavior;
- removal of pseudo-navigation choices;
- skill-generated-data detection and bounded deletion;
- installer self-uninstall preservation boundaries.

## Explicit non-goals

Do not add without a demonstrated need:

- authoritative central installer receipts;
- whole-drive scanning for installed skills or generated data;
- hidden widening from project scope to user scope;
- automatic semantic project initialization;
- another TUI framework;
- Clack fork/monkey patch;
- speculative plugin/package-manager abstractions beyond the current manifest model;
- automatic deletion of skill-generated data during ordinary skill uninstall;
- automatic deletion of installed skills or skill runtime/tooling during installer self-uninstall.

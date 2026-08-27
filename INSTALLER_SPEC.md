# jl-skills installer

Status: accepted installer lifecycle contract aligned to the Bun/Clack implementation and native Map runtime.

## Product goal

`jl-skills` is the user-facing installer, updater, uninstaller, and lifecycle utility for the `jl-skills` catalog. Consumers should not need to know where skill discovery files, harness-specific resources, runtimes, instruction fragments, support assets, or installer update mechanics belong.

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

JL-owned custom controls may wrap Clack core only where the accepted navigation/state behavior requires it. Do not replace the prompt stack with a different TUI framework, fork Clack, or globally monkey-patch it.

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

`--agent` is repeatable.

For explicit non-interactive install:

- `--instructions` means inject managed instructions for every selected skill into every selected harness instruction file;
- `--no-instructions` means inject none;
- if neither flag is supplied, instruction injection defaults to none.

For explicit interactive install where instruction choice remains unspecified, the generalized instruction-injection multiselect is still shown.

The interactive existing-installation preflight described below is a wizard UX contract. Explicit non-interactive install may retain deterministic reapply behavior unless a separate CLI contract is accepted later.

Interactive lifecycle actions such as skill-generated-data removal, installer update, and installer self-uninstall live on the bare-executable home screen unless a separate deterministic CLI contract is accepted later.

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

The canonicalized path is the value used by the UI whenever a concrete path is displayed. An input such as `c:/programming/example` should therefore display in normalized Windows form such as `C:\Programming\example` where the filesystem can establish that casing.

Install may create an uninitialized requested target directory and only the non-semantic structures required for discovery, harness resources, managed instructions, runtime placement, and declared support assets.

## Harness adapters

Initial supported harnesses:

- OpenAI Codex
- Claude Code

Each adapter owns its user/project discovery paths, instruction-file convention, skill-resource placement, and detection logic.

Detection remains internal. Do not put `detected`, `not detected`, `recommended`, or similar status hints on picker options.

No Clack option `hint` is used unless a future requirement explicitly calls for one specific hint.

## Filesystem-first installation discovery

There is no authoritative central installer receipt registry.

The selected scope's actual harness filesystem state is the source of truth for whether catalog skills are installed there.

For each supported harness at the selected scope, the installer checks the expected skill-discovery location. A catalog skill is recognized from its installed `SKILL.md` and self-reported jl-skills metadata.

Every catalog skill must self-report at least:

```text
name
version
metadata format version
```

Current representation:

```html
<!-- jl-skills-meta: {"name":"map","version":"0.2.0","format":1} -->
```

The manifest version and source `SKILL.md` self-report must agree at build/catalog-generation time and runtime validation time.

This deliberately permits jl-skills to discover a compatible skill that was copied or installed by another agent instead of requiring that jl-skills performed the original installation.

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
Update jl-skills installer
Uninstall jl-skills installer
```

There is no visible Cancel row. Escape exits.

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

Scope choices:

```text
Current directory
User account
Custom path
```

There are no visible `Go back` or `Cancel & exit` rows. Backspace goes back where a previous interactive step exists. Escape exits.

Custom-path input is validated. Empty submission must produce a validation message such as `Please provide a path.` rather than throwing. Returning to the custom-path step retains its entered text.

### Selection controls and footer labels

Multiselect menus contain only substantive choices. Do not add pseudo-options for:

```text
All of the above
Go back
Cancel & exit
```

Accepted keys and visible labels:

```text
↑/↓       navigate
Space     select
Enter     confirm
A         toggle all
Backspace back
Esc       exit
```

Only the up/down navigation keys use symbolic arrows. Space, Enter, Backspace, and Escape are written by name so the footer remains unambiguous across terminal fonts.

`I` may remain as an undisclosed invert-selection shortcut.

Multiselect footer shape:

```text
↑/↓ navigate • Space select • Enter confirm • A toggle all • Backspace back • Esc exit
```

Single-select footer shape:

```text
↑/↓ navigate • Enter confirm • Backspace back • Esc exit
```

Text input may omit navigation/select controls that do not apply, but must use the same explicit key-name vocabulary for confirm/back/exit.

All applicable hints remain on one line. Do not split the multiselect footer into a second shortcut row.

There is one blank visual guide line between the final answer/input line and the footer so the control does not feel cramped.

The custom renderer must preserve the Clack guide/spine and native-like styling. Key/control labels are dimmed while explanatory words and separators remain normal intensity.

### Prompt state retention

Wizard state is process-local and explicitly scoped by operation, selected scope, and step identity.

When a user returns to a previously touched step, retain prior state where still valid:

- single-select cursor/choice;
- multiselect cursor;
- multiselect selected values;
- custom-path text.

Selections that no longer exist or become disabled are discarded rather than restored incorrectly.

State must not bleed between unrelated operations or scopes.

A new jl-skills process starts clean.

Destructive confirmations use their safe initial cursor rather than remembering a prior affirmative answer.

### Prompt punctuation

Interactive prompt copy follows ordinary punctuation:

- interrogative questions end in `?`;
- imperative/statement prompts end in `.`;
- note titles/headings are not sentence prompts and do not receive artificial punctuation.

### Standard confirmation control

Do not use Clack's inline binary confirm rendering for lifecycle confirmations.

Every lifecycle confirmation is a normal vertical single-select:

```text
Continue?

Yes
No

↑/↓ navigate • Enter confirm • Backspace back • Esc exit
```

Visible order is always Yes then No.

Normal install/update may begin on Yes. Destructive uninstall/data-removal operations may begin on No. Back returns exactly one interactive question backward.

Use `Continue?` rather than rewriting each confirmation into increasingly explicit action-specific prose after the user already selected the operation.

## Install flow

After scope selection, present the catalog skill picker. Installed skills remain selectable; do not disable a skill merely because it already exists on every currently supported harness. The actual installability decision happens only after the user chooses the target harnesses.

Nothing is preselected on a never-before-touched skill-selection step.

After skill selection, present all supported AI harnesses on one multiselect:

```text
Which AI harnesses should receive these skills?
```

Nothing is preselected on first entry. Do not insert an intermediate harness-selection screen.

### Existing-installation preflight

After skill and harness selection, but before any filesystem writes, inspect every requested skill × selected-harness target at the selected scope.

Classify each target as:

- missing;
- installed and current/newer than the bundled catalog version;
- installed but stale/unknown-version.

Interactive behavior:

- missing targets remain ordinary installs;
- current/newer targets are skipped and must never be downgraded;
- stale targets are grouped by skill;
- if stale skills exist, show one warning and one optional multiselect asking which stale skills should be updated instead;
- the stale-update multiselect starts empty;
- selecting a stale skill updates every stale requested harness target for that skill;
- leaving a stale skill unselected skips those stale targets;
- if all requested targets are already current, report that no changes are needed and perform no write;
- perform all inspection before executing the resulting plan rather than interleaving checks and writes.

Example stale selection:

```text
Some selected skills are already installed but out of date.

Which would you like to update instead?

Map  0.1.0 → 0.2.0
Other Skill  unknown → 1.3.0
```

The stale-selection step follows the same process-local cursor/selection restoration and one-step Back behavior as other wizard steps.

### Instruction-file explanation and selection

After the relevant preflight step, show one informational note with a Title Case title such as:

```text
About AI Instruction Files
```

The note explains the applicable instruction files (`AGENTS.md`, `CLAUDE.md`, or future equivalents) and managed instruction integration.

The note is deliberately skill-agnostic. It must not mention:

- Map;
- any selected skill name;
- the number of selected skills;
- any wording that reveals which skills were selected.

File-name grammar must read naturally. For one file, use a form such as:

```text
The AGENTS.md file contains general instructions ...
```

For multiple files, use a form such as:

```text
AGENTS.md and CLAUDE.md files contain general instructions ...
```

Immediately after the note, present one multiselect containing the selected skills:

```text
Which skills would you like to add to AGENTS.md and CLAUDE.md?

Map
Other Skill
```

Nothing is selected by default on first entry.

The selected subset is applied uniformly to every applicable instruction file for the already-selected harnesses. There is no harness-by-harness matrix.

Even when only one skill was selected for installation, retain this same generalized multiselect flow rather than changing control type or writing skill-specific explanatory copy.

Returning to the instruction-selection step restores the prior submitted subset.

### Installation Summary

The note title is exactly Title Case:

```text
Installation Summary
```

Section headings inside the note remain sentence case. Use simple indentation, comma-delimited compact lists, and newline-delimited locations. No bullet characters.

Instruction injection is file-first: each affected instruction file gets its own line, followed by the selected injected skill subset.

Example:

```text
Skills to install
  Map, Other Skill

Installation location
  C:\Programming\example

Affected AI harnesses
  OpenAI Codex, Claude Code

Instruction injection
  AGENTS.md → Map, Other Skill
  CLAUDE.md → Map, Other Skill
```

With one file:

```text
Instruction injection
  AGENTS.md → Map, Other Skill
```

If no selected skills receive instruction injection:

```text
Instruction injection
  None
```

After confirmation, interactive per-target results use Clack's in-flow logging primitive rather than raw `console.log` so the visual spine remains intact.

Non-interactive output may retain concrete paths for automation/debugging.

## Update Skills flow

After selecting scope, discover installed catalog skills directly from supported harness locations at that scope.

If none are found:

```text
No skills were detected. Choose a different scope or path.
```

Then return to the scope question with its prior cursor retained.

When installations are found, show:

```text
Checking for updates...
```

Compare each installed self-reported version against the bundled catalog version.

Only skills with an applicable update appear in the normal interactive update multiselect.

If no updates exist:

```text
No updates found.
```

Then return to the home screen.

Update choices render aligned skill/version columns where practical:

```text
Map       0.2.0 → 0.3.0
Other     1.4.1 → 1.5.0
```

Unknown installed version metadata is labeled unknown rather than invented.

`Update Skills` owns the complete manifest-declared skill representation for the selected installed targets. A real update must replace/update:

- installed `SKILL.md`;
- other manifest-declared skill files;
- declared runtime artifacts/support files where appropriate;
- managed instruction fragments only according to actual existing instruction state or an explicit CLI override.

Update never adds a newly selected harness. Adding another harness belongs to Install.

Update never initializes or mutates skill-generated semantic/project data.

Regression coverage must deliberately create a stale installed skill/version/content representation and prove that the current catalog contents replace it while unrelated files and generated data remain intact.

The confirmation note title is `Update Summary`.

## Uninstall Skills flow

After selecting scope, discover installed catalog skills directly from supported harness locations at that scope.

If none are found:

```text
No skills were detected. Choose a different scope or path.
```

Otherwise show only installed skills as substantive choices.

Uninstall removes the selected skill integration from discovered/explicit harness targets at that scope:

- skill discovery/resource directory;
- matching installer-managed instruction block if present.

It preserves:

- unrelated `AGENTS.md` / `CLAUDE.md` content;
- unrelated harness configuration and user files;
- skill-generated project data such as `.map/`;
- shared skill runtime/tooling such as Map's shared CLI/schema.

The confirmation note title is:

```text
Uninstall Summary
```

The note follows the same compact sectioned aesthetic as Installation Summary.

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

Instruction fragments render actual provisioned CLI paths when a skill uses a shared runtime rather than assuming the CLI is on `PATH`.

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

Declarations reject absolute paths and parent traversal (`..`).

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

This remains intentionally separate from skill uninstall and installer uninstall.

Flow:

1. ask `Where would you like to remove skill-generated data?`;
2. inspect only that selected scope/path;
3. if none is detected, warn `No skill-generated data was detected. Choose a different scope or path.` and return to scope selection;
4. show only skills whose declared generated data is detected there;
5. ask `Which skills would you like to remove generated data for?`;
6. show exact generated-data paths in a note titled `Permanent Data Removal`;
7. require the standard safe-default `Continue?` confirmation;
8. permanently delete only those declared generated-data paths.

Deletion is recursive and unrecoverable. The note explicitly states that selected data cannot be recovered.

For Map, selecting Map removes the selected project's `.map` directory. Neighboring project files are untouched.

No registry or whole-drive scan is used to find generated data. The user supplies the scope/path and the installer performs narrow declarative detection there.

## Update jl-skills installer

Home-screen `Update jl-skills installer` manages only the compiled installer executable.

It is available only from the compiled `jl-skills` executable, not from an arbitrary development Bun process that cannot correctly replace itself as the installed product.

### Published update contract

Default public manifest location:

```text
https://github.com/jacoblockett/jl-skills/releases/latest/download/jl-skills-manifest.json
```

The URL may be overridden for deterministic development/testing with:

```text
JL_SKILLS_UPDATE_MANIFEST_URL
```

A manifest contains at least:

```json
{
  "version": "0.6.0",
  "artifacts": {
    "windows-x64": {
      "url": "https://.../jl-skills.exe",
      "sha256": "<64 hex characters>"
    }
  }
}
```

The local Windows build emits both:

```text
build/jl-skills.exe
build/jl-skills-manifest.json
```

The generated manifest's Windows artifact URL follows the release-tag contract:

```text
https://github.com/jacoblockett/jl-skills/releases/download/v<VERSION>/jl-skills.exe
```

A manual installer release therefore uses tag `v<VERSION>` and uploads both generated files. The `latest/download` manifest URL then resolves the newest published release while the manifest itself points at the exact versioned executable.

The installer:

1. reports `Checking for updates...`;
2. fetches/parses the manifest;
3. treats a missing published manifest (HTTP 404) as no available update;
4. compares semantic versions;
5. reports `No updates found.` and returns home when the running version is current/newer;
6. requires a current-platform artifact for a newer release;
7. shows an `Update Summary` containing current and available versions;
8. uses the standard `Continue?` confirmation;
9. downloads the replacement to a sibling staging path;
10. validates SHA-256 before replacement;
11. leaves the currently running executable untouched while staging;
12. on Windows, starts the smallest detached post-exit replacement command;
13. preserves installed skills, skill runtime/tooling, and skill-generated data.

A failed hash/version/manifest check must fail rather than install an unverifiable executable.

Automated smoke is entirely offline through a fake fetch/update source and must never replace the real development executable.

## Uninstall jl-skills installer

This action is intentionally installer-only.

It must not uninstall skills, remove skill runtimes/tooling, or remove skill-generated project data.

Do not show a verbose uninstall summary enumerating executable paths, installer-data paths, absent data, or preserved skill state.

Instead show one concise warning:

```text
This action will uninstall the jl-skills installer and any associated installer-owned data and tooling.
```

Then use the standard safe-default `Continue?` confirmation.

After confirmation:

- remove actual installer-owned data if present;
- schedule deletion of the running Windows executable after it exits;
- preserve installed skills and self-reported metadata;
- preserve skill-specific shared support/runtime directories such as `~/.jl-skills/map/...`;
- preserve all generated project data.

Do not describe or delete a nonexistent central installer registry.

## Note-title convention

Clack note titles use Title Case unless a future specific visual decision says otherwise.

Required current titles include:

```text
About AI Instruction Files
Installation Summary
Update Summary
Uninstall Summary
Permanent Data Removal
```

Section headings inside those notes may remain sentence case.

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

Installing/updating Map must not:

- create `.map/`;
- create/open an embedded project database;
- invoke `map init`;
- create semantic graph nodes/relations;
- create a recovery session;
- overwrite unrelated harness configuration or unmanaged instruction content.

`map init` alone creates Map project state, including Map-local `.map/project.json` identity metadata.

There is no machine-level Map project registry in the accepted lifecycle.

## Build and smoke pipeline

The current Windows x64 local pipeline is:

```text
cargo test --release --manifest-path skills/map/Cargo.toml --target-dir build/cargo/map
bun run build
bun run test:installer
```

`bun run smoke` runs that pipeline.

The build produces:

```text
build/jl-skills.exe
build/jl-skills-manifest.json
```

and removes stale singular `build/jl-skill.exe` output.

Catalog generation validates each source skill's self-report metadata against its manifest before shipping the catalog.

Regression coverage includes at least:

- hard scope isolation;
- custom-path normalization;
- self-reported skill metadata installation/discovery;
- manual/filesystem-discovered installation handling;
- interactive install preflight classification across missing/current/stale targets;
- no downgrade of newer installed versions during Install preflight;
- managed instruction opt-in/opt-out and boundary safety;
- stale installed skill/version/content replacement;
- preservation of unrelated/generated data during update;
- update discovery/version comparison;
- uninstall preservation of generated data and shared tooling;
- keyboard multiselect/back/select-all behavior;
- removal of visible navigation pseudo-options;
- one-line navigation-footer key labels;
- absence of inline Clack lifecycle confirmations;
- skill-generated-data bounded deletion;
- offline installer updater metadata/version/hash/staging behavior;
- release-manifest hash matching the built executable;
- installer self-uninstall preservation boundaries.

## Explicit non-goals

Do not add without a demonstrated need:

- authoritative central installer receipts;
- whole-drive scanning for installed skills or generated data;
- hidden widening from project scope to user scope;
- automatic semantic project initialization;
- another TUI framework;
- Clack fork/monkey patch;
- harness-by-harness instruction-injection matrices;
- speculative plugin/package-manager abstractions beyond the current manifest model;
- automatic deletion of skill-generated data during ordinary skill uninstall;
- automatic deletion of installed skills or skill runtime/tooling during installer self-uninstall.

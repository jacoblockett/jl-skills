# jl-skills installer

Status: accepted generic installer lifecycle contract. Skill source, packaging, runtime build details, and skill-specific behavior live in each referenced skill repository; JLS owns only installer behavior and external skill discovery.

## Product goal

`jl-skills` is the user-facing installer, updater, uninstaller, and lifecycle utility for the `jl-skills` catalog. Consumers should not need to know where skill discovery files, harness-specific resources, runtimes, instruction fragments, support assets, or installer update mechanics belong.

Public releases use one self-contained installer executable per supported target. Release asset names identify the target OS/architecture/ABI directly; users must not be expected to infer compatibility from the file extension.

Required canonical targets:

```text
windows-x64
windows-arm64
macos-x64
macos-arm64
linux-x64-gnu
linux-arm64-gnu
linux-x64-musl
linux-arm64-musl
```

Exact public installer filenames:

```text
jl-skills-windows-x64.exe
jl-skills-windows-arm64.exe
jl-skills-macos-x64
jl-skills-macos-arm64
jl-skills-linux-x64-gnu
jl-skills-linux-arm64-gnu
jl-skills-linux-x64-musl
jl-skills-linux-arm64-musl
```

These target keys and filenames are part of the durable installer/release contract. `RELEASES.md` owns the complete release-manifest and publication contract; `TODO.md` owns implementation order.

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
Bun --compile -> target-qualified jl-skills executable
```

Every compiled installer carries exactly one canonical target key injected at build time. That embedded value is authoritative for installer self-update, skill-package selection, native-runtime selection, output naming, and target diagnostics. Do not derive release identity from runtime `platform + arch` alone, because Linux also requires GNU/glibc vs musl ABI identity.

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

The interactive existing-installation inspection described below is a wizard UX contract. Explicit non-interactive install may retain deterministic reapply behavior unless a separate CLI contract is accepted later.

Interactive lifecycle actions such as skill-generated-data removal, installer update, and installer self-uninstall live on the bare-executable home screen unless a separate deterministic CLI contract is accepted later.

## Hard scope invariant

Scope and harness selection are orthogonal:

```text
WHERE?  --scope user|cwd|PATH
WHO?    selected harnesses / explicit --agent values
```

The requested scope is authoritative. Harness detection or availability must never widen, relocate, or duplicate installation into another scope.

For a project/path install, a machine-level Codex or Claude installation permits those harness adapters to target only the requested project. It does not authorize user-scope skill copies or user-scope instruction injection.

Skill runtime/tooling is also scope-local. Each installed skill receives one neutral tooling directory at the selected scope, shared by every harness using that skill at that scope:

```text
user scope       ~/.jl-skills/<skill>/
project/custom   <scope>/.jl-skills/<skill>/
```

A project/path install must never provision that skill's tooling under the user's home scope. A user-scope install must never provision tooling into the invocation project.

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
<!-- jl-skills-meta: {"name":"map","version":"0.5.0","format":1} -->
```

The manifest version and source `SKILL.md` self-report must agree at build/catalog-generation time and runtime validation time.

This deliberately permits jl-skills to discover a compatible skill that was copied or installed by another agent instead of requiring that jl-skills performed the original installation.

If a recognizable catalog skill exists but usable version metadata is absent or malformed, presence may still be detected, but its installed version is unknown. Never fabricate a version.

## Interactive navigation contract

### Home screen

Running the installer without an explicit action starts with:

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

### Selection controls and footer hints

Multiselect menus contain only substantive choices. Do not add pseudo-options for:

```text
All of the above
Go back
Cancel & exit
```

Accepted visible key hints:

```text
↑/↓      navigate
Space    select
Enter    confirm
A        toggle all
Backspace back
Esc      exit
```

`I` may remain as an undisclosed invert-selection shortcut.

Multiselect footer shape:

```text
↑/↓ navigate • Space select • Enter confirm • A toggle all • Backspace back • Esc exit
```

Single-select footer shape:

```text
↑/↓ navigate • Enter confirm • Backspace back • Esc exit
```

Text input may omit navigation/select controls that do not apply, but must use the same explicit key names for confirm/back/exit.

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

After scope selection, present the catalog skill picker. Installed skills remain selectable; do not disable a skill merely because it already exists on every currently supported harness. The actual existing-installation decision happens only after the complete requested configuration has been confirmed.

Nothing is preselected on a never-before-touched skill-selection step.

After skill selection, present all supported AI harnesses on one multiselect:

```text
Which AI harnesses should receive these skills?
```

Nothing is preselected on first entry. Do not insert an intermediate harness-selection screen.

### Instruction-file explanation and selection

After harness selection, show one informational note with a Title Case title such as:

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

### Installation Summary and confirmation boundary

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

The standard `Continue?` confirmation follows this summary.

For the interactive wizard, **do not inspect existing skill installations before the user confirms Yes**. The complete request is collected and summarized first. Yes is the boundary after which jl-skills may inspect current installation state and execute/adapt the confirmed request.

No confirmed request means no existing-install inspection and no filesystem mutation from this install operation.

### Post-confirm existing-installation inspection

After Yes, inspect every requested skill × selected-harness target at the selected scope before making any resulting filesystem writes.

For each target, compare the actual installation against the complete requested configuration. The requested configuration includes:

- skill;
- harness;
- installed/catalog version relationship;
- requested managed instruction-injection state for that skill;
- actual presence/absence of that skill's managed block in that harness instruction file.

Classify each target as:

- missing;
- already satisfied in the requested configuration;
- installed at the current/newer version but instruction configuration differs;
- stale/unknown-version and update-eligible.

A current or newer installed version alone does not make the request satisfied. The managed instruction state must also match what the user just confirmed.

If a current or newer installation has no managed instruction block and the confirmed request includes instruction injection, add the managed block as configuration work.

If a current or newer installation has a managed instruction block and the confirmed request excludes instruction injection, remove only that managed block as configuration work.

Configuration-only work must not rewrite or downgrade the installed skill/runtime simply to change the instruction setting.

A newer installed skill version must never be downgraded to the bundled version.

### Already-satisfied skills

A skill is considered wholly already installed only when every requested harness target for that skill is satisfied in the confirmed configuration.

A mixed request such as Map already satisfied for Codex but missing for Claude remains a continuing Map installation and is not presented as wholly already installed.

When one or more whole requested skills are already satisfied, show one note block:

```text
The Following Skills Have Already Been Installed

Map, Other Skill
```

The body is a single comma-delimited skill list. Do not enumerate harnesses, versions, explanations, or internal state in this note.

### Stale installations encountered during Install

Stale/unknown-version requested targets are grouped by skill after confirmation.

Show one warning followed by one optional multiselect:

```text
Some selected skills are already installed but out of date.

Which would you like to update instead?

Map  0.3.0 → 0.5.0
Other Skill  unknown → 1.3.0
```

The selection starts empty.

Selecting a skill updates every stale requested harness target for that skill. Leaving it unselected skips those stale targets.

Back from this post-confirm update choice returns to the final confirmation rather than skipping backward past it.

### Continue or return home

After classification and any stale-update selection, compute the remaining actionable skills.

Only when one or more whole requested skills were removed from the work list as already satisfied and at least one other requested skill still has missing targets, instruction-configuration work, or approved stale updates, show one ordinary status line:

```text
Installation will continue for: Map, Other Skill.
```

Do not show this continuation status for an ordinary one-skill installation or when no whole requested skill was removed from the work list.

Then perform only the remaining work.

If nothing remains:

```text
There is nothing to install.
```

Do not emit `No changes needed`, `No changes made`, or similar internal/meta narration.

In the bare wizard, return to the primary:

```text
What would you like to do?
```

screen.

All post-confirm inspection occurs before any resulting filesystem write. Do not interleave check/write/check/write.

After actual installation/configuration/update work completes, interactive per-target results use Clack's in-flow logging primitive rather than raw `console.log` so the visual spine remains intact.

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

Compare each installed self-reported version against the published catalog version.

Only skills with an applicable update appear in the normal interactive update multiselect.

If installed skills are present but no updates exist:

```text
All skills are already up to date. Choose a different scope or path.
```

Then return to the same `Where would you like to update skills?` scope question with its prior cursor/state retained. Do not return to the home screen merely because the selected update scope has no applicable updates, and do not use the generic `No updates found.` copy for this flow.

Update choices render aligned skill/version columns where practical:

```text
Map       0.4.0 → 0.5.0
Other     1.4.1 → 1.5.0
```

Unknown installed version metadata is labeled unknown rather than invented.

`Update Skills` owns the complete manifest-declared skill representation for the selected installed targets. A real update must replace/update:

- installed `SKILL.md`;
- other manifest-declared skill files;
- declared scope-local runtime artifacts/support files where appropriate;
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
- harness-specific resources owned by that skill;
- matching installer-managed instruction block if present.

Scope-local tooling is shared only among harness integrations for that same skill at that same scope. Removing one harness leaves `<scope>/.jl-skills/<skill>/` intact while another harness at that scope still has the skill installed. Removing the final harness integration for that skill at that scope removes the skill's scope-local tooling directory.

Uninstall preserves:

- unrelated `AGENTS.md` / `CLAUDE.md` content;
- the instruction file itself even if removing the managed block leaves it empty;
- harness parent directories such as `.agents`, `.agents/skills`, `.codex`, `.codex/agents`, `.claude`, and `.claude/agents`;
- unrelated harness configuration and user files;
- skill-generated project data such as `.map/`.

The `Uninstall Summary` contains only the selected skills, uninstall location, and affected AI harnesses. Do not add a `Preserved data` section.

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
- if that removal leaves the instruction file empty, retain the file as an empty file rather than deleting it;
- opting out leaves an unrelated existing instruction file untouched.

Instruction fragments render the actual scope-local provisioned CLI path rather than assuming the CLI is on `PATH`.

## Package model

Installation is manifest-driven.

A package may declare:

- name/version/description;
- skill files;
- harness-specific resources such as native subagent definitions;
- runtime kind;
- platform runtime artifacts;
- runtime support files;
- runtime CLI name;
- instruction fragment;
- generated-data locations;
- future harness/subagent resources or migrations when explicitly needed.

Skill packages do not choose absolute or scope-independent runtime destinations. The installer owns runtime placement under the selected scope's `.jl-skills/<skill>/` directory.

Harness filesystem knowledge belongs in adapters, not duplicated in every skill package.

Semantic project initialization is never an installer hook.

### External skill releases and target selection

JLS does not build or package skill source. The JLS release manifest contains a reference to each skill repository's published release manifest.

Each skill repository owns whether its package is target-specific or portable, and owns the SHA-256 values and immutable URLs for those packages. For a native skill, each published package contains common skill/harness/support files plus only the runtime for one canonical target. A genuinely platform-independent skill may publish the reserved `portable` artifact key.

Artifact selection is exact-target first, then explicit `portable` fallback for skills only. Never fall back to another OS, architecture, or ABI.

The downloaded package's own manifest remains authoritative for install semantics after download. JLS validates that package metadata agrees with the external skill release manifest before installation.

## Skill-generated data contract

Skills may declare generated project data in their manifest. Each declaration is a relative path beneath the user-selected scope and may include a narrow marker used to verify that the path is actually that skill's generated data.

Declarations reject absolute paths and parent traversal (`..`).

Example:

```json
"generated_data": [
  {
    "path": ".example-state",
    "marker": "project.json"
  }
]
```

The installer may retain a small installer-owned copy of declarative skill metadata under its own data directory so the separate generated-data removal flow can recognize declared data after ordinary skill uninstall. This cache is not an authoritative installation receipt and is never used as the source of truth for whether a skill is installed.

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

Only the selected skill's declared and positively detected generated-data paths are removed. Neighboring project files are untouched.

No registry or whole-drive scan is used to find generated data. The user supplies the scope/path and the installer performs narrow declarative detection there.

## Update jl-skills installer

Home-screen `Update jl-skills installer` manages only the compiled installer executable.

It is available only from the compiled `jl-skills` executable, not from an arbitrary development Bun process that cannot correctly replace itself as the installed product.

### Published update contract

Default public stable manifest location:

```text
https://github.com/jacoblockett/jls/releases/latest/download/manifest.json
```

The URL may be overridden for deterministic development/Nightly testing with:

```text
JL_SKILLS_UPDATE_MANIFEST_URL
```

JLS release-manifest format 3 contains the installer `version`/target artifacts plus a `manifest_url` reference for each externally owned skill. Each referenced skill manifest contains that skill's `version`, `min_installer`, and target/portable artifacts with SHA-256 values. The exact format-3 JLS index and external skill-manifest contracts are authoritative in `RELEASES.md`.

The installer update flow selects only `installer.artifacts[currentTarget]`, where `currentTarget` is the running executable's build-time embedded canonical target. Missing current-target support is an incompatibility error; never fall back to a different OS, architecture, or ABI.

Skill install/update selection uses `skill.artifacts[currentTarget]` first and may use `skill.artifacts.portable` only when the skill explicitly publishes it. No other fallback is allowed.

Stable release tags remain immutable UTC timestamp snapshot identities. Nightly uses the rolling `nightly` tag. Component update and compatibility decisions use semantic installer/skill versions, not the distribution tag.

The installer:

1. reports `Checking for updates...`;
2. fetches/parses the manifest;
3. treats a missing published manifest (HTTP 404) as no available update;
4. compares semantic versions;
5. reports `No updates found.` and returns home when the running version is current/newer;
6. requires a current-target artifact for a newer release;
7. shows an `Update Summary` containing current and available versions;
8. uses the standard `Continue?` confirmation;
9. downloads the replacement to a sibling staging path;
10. validates SHA-256 before replacement;
11. leaves the currently running executable untouched while staging;
12. performs the smallest safe platform-native post-exit replacement operation where in-process replacement is not possible;
13. preserves installed skills, their scope-local tooling, and skill-generated data.

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

After the user confirms Yes, the foreground `jl-skills` process delegates the entire installer-owned cleanup request to a silent detached helper and exits immediately. The foreground process must not print `scheduled`, `complete`, success, failure, or any other post-confirmation status.

The helper waits long enough for the foreground process to release the executable, then removes:

- actual installer-owned data if present;
- the installer executable itself.

The helper must use ignored stdio and must not present a visible helper shell/window. The same lifecycle applies on Windows and Unix-like platforms, with platform-native cleanup commands hidden behind the same user-visible behavior.

The helper must preserve:

- installed skills and self-reported metadata;
- every skill's scope-local runtime/tooling directories;
- all generated project data.

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

## Build and smoke pipeline

JLS builds only the installer. It does not compile skill runtimes or create skill archives.

Local smoke:

```text
bun run build
bun run test:installer
```

GitHub Actions builds all eight canonical installer targets, launches each compiled installer in its native consumer environment (musl targets in pinned Alpine), aggregates the eight installer artifacts, verifies SHA-256 and catalog-reference consistency, and publishes only the verified installer bundle plus `manifest.json`.

Skill repositories own their own runtime/package build and acceptance pipelines.

Regression coverage includes at least:

- hard scope isolation;
- custom-path normalization;
- self-reported skill metadata installation/discovery;
- manual/filesystem-discovered installation handling;
- interactive install inspection only after final confirmation;
- install satisfaction including requested managed-instruction state;
- configuration-only managed-block changes without rewriting current/newer skill content;
- no downgrade of newer installed versions during Install handling;
- install continuation status only when whole requested skills were skipped;
- managed instruction opt-in/opt-out and boundary safety;
- retention of empty instruction files and harness parent directories during uninstall;
- stale installed skill/version/content replacement;
- preservation of unrelated/generated data during update;
- scope-local runtime/tooling placement and cross-scope isolation;
- update discovery/version comparison;
- Update Skills no-update return to the chosen-scope picker;
- final-harness uninstall removal of scope-local tooling while preserving generated data;
- partial-harness uninstall retention of tooling while another harness still owns the skill at that scope;
- keyboard multiselect/back/select-all behavior;
- removal of visible navigation pseudo-options;
- one-line explicit navigation-footer vocabulary;
- absence of inline Clack lifecycle confirmations;
- skill-generated-data bounded deletion;
- offline installer updater metadata/version/hash/staging behavior;
- release-manifest hash matching the built executable;
- target-qualified installer naming;
- external skill-reference parsing and target/portable artifact selection;
- installer self-uninstall preservation boundaries;
- installer self-uninstall silent delegated cleanup with no post-confirmation foreground status.

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
- absolute or cross-scope runtime destinations selected by skill packages;
- automatic deletion of skill-generated data during ordinary skill uninstall;
- automatic deletion of installed skills or skill runtime/tooling during installer self-uninstall.

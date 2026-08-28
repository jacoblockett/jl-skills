# Installer + Map UI Smoke Review

Status: active review tracker for `spec-installer-lifecycle`.

Purpose: preserve unresolved UX, lifecycle, and regression requirements in priority order. Current interactive-review requirements override older wording where they conflict. Older carry-forward work remains isolated at the end.

Do not mark an item resolved merely because code changed. Current-turn items must survive the relevant automated and manual smoke checks.

# Current Interactive Follow-Up — Highest Priority

## P0 — Keep navigation hints explicit and single-line

Use ordinary key names except for the unambiguous arrow-navigation glyph:

```text
↑/↓  navigate
Space select
Enter confirm
A     toggle all
Backspace back
Esc   exit
```

Required presentation:

- Keep every applicable hint on one line.
- Use `exit`, not `cancel`, for Escape copy.
- Keep one blank visual guide line between the final answer/input and the footer.
- Preserve the native-like Clack dimming pattern and guide/spine.
- Do not use symbolic substitutes for Space, Enter, Backspace, or Escape.

Multiselect footer:

```text
↑/↓ navigate • Space select • Enter confirm • A toggle all • Backspace back • Esc exit
```

Single-select/binary footer:

```text
↑/↓ navigate • Enter confirm • Backspace back • Esc exit
```

## P0 — Fix AI instruction-file explanatory English

The informational note remains completely skill-agnostic, but its file-name grammar must read naturally.

For one applicable file, use the grammatical form:

```text
The AGENTS.md file contains general instructions ...
```

For multiple applicable files, use the grammatical form:

```text
AGENTS.md and CLAUDE.md files contain general instructions ...
```

Do not produce constructions such as `AGENTS.md file contains ...` without the article.

The note still must not reveal which skills were selected.

## P0 — Make Installation Summary instruction injection file-first

Use one line per affected instruction file, with the file first and the selected injected skill subset second.

One skill, one file:

```text
Instruction injection
  AGENTS.md → Map
```

Multiple skills, one file:

```text
Instruction injection
  AGENTS.md → Map, Other Skill
```

Multiple skills, multiple files:

```text
Instruction injection
  AGENTS.md → Map, Other Skill
  CLAUDE.md → Map, Other Skill
```

No injection:

```text
Instruction injection
  None
```

The same selected skill subset still applies uniformly across all selected harness instruction files; there is no harness-by-harness injection matrix.

## P0 — Inspect existing installations only after final confirmation

The interactive Install wizard must collect the complete requested configuration first:

1. scope;
2. skills;
3. harnesses;
4. instruction-injection subset;
5. Installation Summary;
6. final `Continue?` confirmation.

Do not inspect or warn about existing skill installations before the user answers Yes to that final confirmation. Confirmation is the boundary between planning and execution.

After Yes, inspect every requested skill × selected-harness target at the selected scope and compare the actual installation against the complete requested configuration.

The requested configuration includes at least:

- requested skill;
- requested harness;
- installed/catalog version relationship;
- whether managed instruction injection was requested for that skill and whether the matching managed block currently exists for that harness.

Classify each target as:

- missing;
- already satisfied in the requested configuration;
- current/newer version but instruction configuration differs;
- stale/unknown-version and update-eligible.

A current/newer installation is **not** already satisfied when its instruction-injection state differs from the newly confirmed request. Adding or removing the managed instruction block is real configuration work.

Examples:

```text
Existing: Map current for Codex, no AGENTS.md block
Requested: Map current for Codex, inject into AGENTS.md
Result: configuration work; add the managed block
```

```text
Existing: Map current for Codex, AGENTS.md block present
Requested: Map current for Codex, no instruction injection
Result: configuration work; remove only the managed block
```

Do not rewrite/downgrade the installed skill merely to change this instruction configuration. Configuration-only work changes only the matching managed instruction block.

### Already-satisfied warning

A skill belongs in the already-installed warning only when **every requested harness target for that skill** is already satisfied in the requested configuration.

A mixed skill, such as Map already satisfied for Codex but missing for Claude, remains a continuing-install skill and is not listed as wholly already installed.

If one or more whole requested skills are already satisfied, show one note block:

```text
The Following Skills Have Already Been Installed

Map, Other Skill
```

The body is one comma-delimited line. Do not enumerate harnesses, versions, explanations, or internal state in that note.

### Stale installations

Stale/unknown-version targets remain grouped by skill. If stale skills exist, show the existing optional update selection after confirmation:

```text
Some selected skills are already installed but out of date.

Which would you like to update instead?

Map  0.1.0 → 0.2.0
Other Skill  unknown → 1.3.0
```

The stale-update multiselect starts empty. Selecting a skill updates every stale requested harness target for that skill. Leaving it unselected skips those stale targets.

### Continue or return home

After already-satisfied/configuration/stale classification and any stale-update selection, compute the remaining actionable skills.

Only show the continuation status when at least one whole requested skill was removed from the work list because it was already satisfied and at least one other skill still has work remaining:

```text
Installation will continue for: Map, Other Skill.
```

Do not show that status for an ordinary one-skill installation or when no requested skill was removed from the work list.

If nothing remains:

```text
There is nothing to install.
```

Do not show `No changes needed`, `No changes made`, or update-oriented meta narration. In the bare wizard, return directly to the primary `What would you like to do?` screen.

All inspection happens before any resulting filesystem writes. Do not interleave check/write/check/write.

The explicit non-interactive CLI may retain deterministic reapply behavior; this post-confirm inspection requirement is for the interactive wizard flow unless a separate CLI contract is accepted later.

## P0 — Keep Update Skills inside the chosen-scope loop when everything is current

Update Skills starts by asking:

```text
Where would you like to update skills?
```

After the user chooses a scope/path:

- if no skills are installed there, retain the existing warning:

```text
No skills were detected. Choose a different scope or path.
```

- if installed skills are present but none have an available update, show:

```text
All skills are already up to date. Choose a different scope or path.
```

Then return to the **same** `Where would you like to update skills?` scope question with prior local cursor/state retained.

Do not return to the home screen merely because the chosen update scope has no applicable updates. Do not use the generic `No updates found.` copy for the Update Skills flow.

A scope with available updates continues into the existing update-selection multiselect and normal Update Summary/confirmation lifecycle.

A manual smoke path must be available without publishing a real release: install the current bundled skill into the isolated UI-smoke project, deliberately lower only the installed skill metadata version, then launch the compiled installer and choose Update Skills for that project. This should expose the real update picker with an older-installed → bundled-current version transition and allow the user to exercise the real interactive update flow end to end.

# Existing Current-Turn Requirements

## P0 — Generalize instruction injection across selected skills

After the user selects skills to install and selects one or more AI harnesses:

1. Show one informational note explaining the applicable harness instruction files such as `AGENTS.md`, `CLAUDE.md`, or future equivalents.
2. The note must be completely skill-agnostic. It must not mention Map, any selected skill name, how many skills were selected, or otherwise reveal the selected skill set.
3. Immediately after the note, show one multiselect containing every skill the user requested to install.
4. Ask which of those skills should have managed instructions injected into all applicable instruction files for the already-selected harnesses.
5. Nothing is selected by default on first entry.
6. Returning to this step restores the prior submitted subset.
7. The same selected subset is applied uniformly to every selected harness instruction file. There is no harness-by-harness matrix.
8. The generalized multiselect remains the same even when the selected skill list contains only one skill.

Example:

```text
About AI Instruction Files
  <generic explanation of AGENTS.md / CLAUDE.md and managed skill instructions>

Which skills would you like to add to AGENTS.md and CLAUDE.md?

□ Map
□ Another Skill
```

Update preserves the actual existing managed-block state of each installed skill/harness target when using the dedicated Update flow. Uninstall removes only the matching managed block for the selected installed target.

## P0 — Replace inline confirmation controls project-wide

Do not use the inline Clack confirm rendering for final confirmations.

Every confirmation is a normal vertical single-select:

```text
Continue?

● Yes
○ No

↑/↓ navigate • Enter confirm • Backspace back • Esc exit
```

Requirements:

- `Yes` first, `No` second.
- One choice per line.
- Navigation footer remains visible.
- Blank line between choices and footer.
- Use `Continue?` consistently instead of rewriting confirmations into action-specific prose.
- Destructive actions may retain a safe initial cursor/default, but visible order remains Yes then No.
- Back returns exactly one question backward and preserves prior state.

Apply to install, skill update, skill uninstall, generated-data deletion, installer update, and installer uninstall.

## P1 — Simplify installer uninstall UX

Remove the verbose installer-uninstall summary.

Do not enumerate executable paths, installer-owned data paths, absence of installer-owned data, or preserved skill/runtime/project data.

Show one concise warning:

```text
This action will uninstall the jl-skills installer and any associated installer-owned data and tooling.
```

Then show the standard `Continue?` control.

After the user confirms Yes, the foreground `jl-skills` process delegates all installer-owned cleanup to a silent detached helper and exits immediately. Do not print `scheduled`, `complete`, success, failure, or any other post-confirmation status from the foreground process.

The helper removes the installer executable and actual installer-owned data/tooling after the foreground process has released the executable. It must not inherit visible stdio or open a visible helper shell. The same lifecycle applies on Windows and Unix-like platforms, using the smallest platform-native helper primitive required for self-removal.

Installed skills, skill runtime/tooling, and skill-generated project data remain untouched, but that preservation is not narrated on this screen.

## P1 — Normalize note-block titles

Clack note titles use Title Case unless a specific visual reason requires otherwise.

Required examples:

```text
Installation Summary
Update Summary
Uninstall Summary
Permanent Data Removal
About AI Instruction Files
```

## P1 — Update jl-skills installer

Home action order includes:

```text
Remove skill-generated data
Update jl-skills installer
Uninstall jl-skills installer
```

Required updater behavior remains:

- compare the running installer against an authoritative release manifest;
- report `No updates found.` when current;
- show `Update Summary` when newer;
- use standard `Continue?`;
- stage and SHA-256 verify the replacement;
- replace the running Windows executable after process exit;
- preserve installed skills, runtimes/tooling, and generated data;
- automated smoke remains network-independent and does not replace the development executable.

## P1 — Prove the dedicated Update Skills pipeline

Regression coverage must prove a deliberately stale installed skill is upgraded to current catalog content/version while preserving unrelated files, generated data, harness boundaries, and existing managed-instruction state unless explicitly overridden.

Update never adds a new harness and never initializes/mutates skill-generated semantic data.

## P2 — Preserve accepted installer invariants

- Product/executable remains `jl-skills` / `jl-skills.exe`.
- Top-level operation selection occurs before scope discovery.
- Harness detection never widens installation scope.
- Harness picker shows all supported harnesses and starts empty.
- No Clack option `hint` fields for detected/recommended/version clutter.
- Keyboard Back returns exactly one question backward.
- Process-local cursor/selection/custom-path state restores for the same operation and scope.
- State does not bleed between unrelated operations or scopes.
- Managed instruction blocks preserve unrelated user content and reject malformed/ambiguous boundaries instead of guessing.
- Skill uninstall preserves skill-generated data and shared runtime/tooling.
- Generated-data deletion remains a separate user-selected-scope operation with no whole-drive scan.
- Installer self-uninstall remains installer-only.
- Custom paths remain normalized before any user-visible redisplay.

## P2 — Reconcile specs and smoke

After implementation:

1. Reconcile accepted behavior into `INSTALLER_SPEC.md` and any affected Map spec text.
2. Run full Windows `bun run smoke`.
3. Run complete interactive smoke against the compiled executable.
4. Keep PR #8 draft until checks pass or a remaining item is explicitly deferred.

# Prior Carry-Forward Work — Save for Later

## Historical Map skill/sub-agent orchestration investigation

The earlier intended Map skill/sub-agent architecture remains unresolved.

Before redesigning `skills/map/SKILL.md` around orchestration:

1. Deep-search `jacoblockett/jl-skills` history.
2. Deep-search `jacoblockett/persist` history.
3. Recover or rule out the earlier accepted orchestrator/sub-agent contract.
4. Compare the recovered design with current Map skill/package resources.
5. Do not invent a replacement architecture first.

The old duplicate/recovery-TUI items are not carried forward because the accepted lifecycle no longer has a machine-level Map project registry or global copied-project arbitration flow.

# Installer + Map UI Smoke Review

Status: active review tracker for `spec-installer-lifecycle`.

Purpose: preserve unresolved UX, lifecycle, and regression requirements in priority order. Current interactive-review requirements override older wording where they conflict. Older carry-forward work remains isolated at the end.

Do not mark an item resolved merely because code changed. Current-turn items must survive the relevant automated and manual smoke checks.

# Current Interactive Follow-Up — Highest Priority

## P0 — Use explicit key names in navigation footers

Unicode key symbols other than the navigation arrows rendered inconsistently or were ambiguous in the user's Windows terminal. Keep only `↑/↓` as a symbolic key hint. Spell out every other visible key name.

Use this visible vocabulary:

```text
↑/↓      navigate
Space    select
Enter    confirm
A        toggle all
Backspace back
Esc      exit
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

The previous summary rendered the selected skills as the left side of one arrow and every affected instruction file on the right side. That does not scale/read as naturally as the file ownership model.

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

## P0 — Preflight existing installations before interactive Install writes

Interactive Install must not blindly rewrite every requested skill/harness target.

After the user selects skills and harnesses, but before any filesystem writes:

1. Inspect every requested skill × selected-harness target at the selected scope.
2. Classify each target as:
   - missing;
   - installed and current/newer than the bundled catalog version;
   - installed but stale/unknown-version and therefore update-eligible.
3. Current targets are skipped rather than reinstalled or downgraded.
4. Missing targets remain normal installs.
5. Aggregate stale targets by skill rather than prompting separately for each harness.
6. If any stale skills exist, show one warning and one optional multiselect such as:

```text
Some selected skills are already installed but out of date.

Which would you like to update instead?

□ Map  0.1.0 → 0.2.0
□ Other Skill  unknown → 1.3.0
```

7. The stale-update multiselect starts empty. A selected skill updates every stale target for that skill among the harnesses already requested. An unselected stale skill is skipped.
8. Do all detection first, then execute the resulting install/update plan after the normal summary/confirmation. Do not interleave check/write/check/write.
9. If every requested target is already current, report that no changes are needed and perform no write.
10. A fully installed skill must remain selectable in the initial Install skill picker so this preflight can make the decision after the harness selection. Do not disable it solely because it exists on every currently supported harness.
11. A newer installed version must be treated as current for Install preflight purposes; never downgrade it to the bundled version.
12. Process-local state for the stale-update chooser follows the same Back/restore rules as every other touched step.

The explicit non-interactive CLI may retain its deterministic reapply behavior; this preflight requirement is for the interactive wizard flow unless a separate CLI contract is accepted later.

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

The implementation removes only the installer executable and actual installer-owned data/tooling. Installed skills, skill runtime/tooling, and skill-generated project data remain untouched, but that preservation is not narrated on this screen.

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

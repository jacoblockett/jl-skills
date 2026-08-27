# Installer + Map UI Smoke Review

Status: active review tracker for `spec-installer-lifecycle`.

Purpose: preserve unresolved UX, lifecycle, and regression requirements in priority order. Current-turn requirements are authoritative for the present implementation pass. Older carry-forward material is isolated at the end and should not interrupt the current installer work.

Do not mark an item resolved merely because code changed. Current-turn items must survive the relevant automated and manual smoke checks.

# Current-Turn Work, Highest Priority First

## P0 — Generalize instruction injection across selected skills

This is the most important current installer behavior change.

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

The final Installation Summary must reflect the selected injection subset and the affected instruction files without assuming Map is the only catalog skill.

Update preserves the actual existing managed-block state of each installed skill/harness target. Uninstall removes only the matching managed block for the selected installed target.

## P0 — Standardize navigation footer glyphs and spacing

Replace spelled-out key names with compact Unicode key symbols:

```text
↑/↓  navigate
␣    select        U+2423 OPEN BOX
↵    confirm       U+21B5 DOWNWARDS ARROW WITH CORNER LEFTWARDS
A    toggle all
⌫    back          U+232B ERASE TO THE LEFT
␛    exit          U+241B SYMBOL FOR ESCAPE
```

`␣` is the preferred Space glyph.

Required presentation:

- Keep every applicable hint on one line.
- Do not split hints across two rows.
- Use `exit`, not `cancel`, for Escape copy.
- Insert one blank visual line between the final answer choice and the footer.
- Apply the spacing rule consistently to selects, multiselects, and binary confirmations.
- Preserve Clack guide/spine styling and the previously corrected native-like dimming pattern.

Multiselect footer shape:

```text
↑/↓ navigate • ␣ select • ↵ confirm • A toggle all • ⌫ back • ␛ exit
```

Single-select/binary footer shape:

```text
↑/↓ navigate • ↵ confirm • ⌫ back • ␛ exit
```

## P0 — Replace inline confirmation controls project-wide

Do not use the inline Clack confirm rendering for final confirmations.

Every confirmation should be a normal vertical single-select:

```text
Continue?

● Yes
○ No

↑/↓ navigate • ↵ confirm • ⌫ back • ␛ exit
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

Remove the current verbose installer-uninstall summary.

Do not enumerate:

- executable path;
- installer-owned data paths;
- absence of installer-owned data;
- preserved skill/runtime/project data.

Instead show one concise warning such as:

```text
This action will uninstall the jl-skills installer and any associated installer-owned data and tooling.
```

Then show the standard `Continue?` vertical Yes/No control.

The implementation still removes only the installer executable and actual installer-owned data/tooling. Installed skills, skill runtime/tooling, and skill-generated project data remain untouched, but that preservation is not narrated on this screen.

## P1 — Normalize note-block titles

The small title at the top of Clack note blocks uses Title Case unless a specific visual reason requires otherwise.

Required examples:

```text
Installation Summary
Update Summary
Uninstall Summary
Permanent Data Removal
About AI Instruction Files
```

Do not use sentence-case note titles such as `Installation summary`, `Update summary`, or `Installer uninstall summary`.

Both skill uninstall and installer uninstall use `Uninstall Summary` only when a summary note is actually warranted. The simplified installer-uninstall path may use a warning instead of a summary note.

## P1 — Add `Update jl-skills installer`

Add this home-screen action in this order:

```text
Remove skill-generated data
Update jl-skills installer
Uninstall jl-skills installer
```

Required behavior:

- Check an authoritative published installer release/version source.
- Compare the running installer version with the newest compatible release.
- If current, report `No updates found.` and return to the home screen.
- If newer, show a concise `Update Summary` with current and target versions.
- Use the standard `Continue?` vertical Yes/No control.
- Download a replacement to a temporary/sibling path.
- Verify the artifact before replacement. Prefer a release manifest containing version and SHA-256.
- On Windows, replace the running executable only after the current process exits.
- Preserve installed skills, skill runtime/tooling, and skill-generated data.
- No re-setup should be necessary after updating the installer.

Automated smoke must not depend on the public network or replace the real development executable. Use a deterministic local/fake update source and cover:

- no-update path;
- newer-version detection;
- successful download/verification;
- version/hash rejection;
- replacement staging;
- preservation boundaries.

## P1 — Prove a real `Update Skills` pipeline

A basic skill update path exists, but regression coverage must prove an actual stale installed skill is upgraded rather than merely reapplying the same version.

Required semantics:

- Discover installed skills from selected scope/harness filesystem state.
- Compare installed self-reported metadata with catalog version.
- Replace installed `SKILL.md` and every other manifest-declared skill asset for selected installed targets.
- Update declared runtime/support assets where appropriate.
- Preserve actual existing managed-instruction state for each installed target.
- Never add a new harness during Update.
- Never initialize or mutate skill-generated semantic/project data.
- Keep update bounded to selected scope and selected skills.

Regression coverage must create a deliberately stale installed representation with older metadata and stale file contents, run Update, and verify current catalog version/content replaces it while unrelated files and generated data remain intact.

Where practical, tests should avoid depending structurally on Map being the only catalog skill.

## P2 — Preserve already-accepted installer invariants

These are regression guards during the current pass:

- Product/executable remains `jl-skills` / `jl-skills.exe`.
- Top-level operation selection occurs before scope discovery.
- Scope is inspected only after operation and scope are chosen.
- Harness detection never widens installation scope.
- Harness picker shows all supported harnesses and starts empty.
- No Clack option `hint` fields for detected/recommended/version clutter.
- Keyboard Back returns exactly one question backward.
- Process-local cursor/selection/custom-path state restores for the same operation and same scope.
- State does not bleed between unrelated operations or scopes.
- A skill installed on only some harnesses remains available under Install so another harness can be added.
- Installation summaries remain compact and generalized for multiple skills.
- Managed instruction blocks preserve unrelated user content and reject malformed/ambiguous boundaries instead of guessing.
- Skill uninstall preserves skill-generated data and shared runtime/tooling.
- Generated-data deletion remains a separate user-selected-scope operation with no whole-drive scan.
- Installer self-uninstall remains installer-only.
- Custom paths remain normalized before any user-visible redisplay.

## P2 — Reconcile specs and automated/manual smoke

After implementation:

1. Reconcile accepted behavior into `INSTALLER_SPEC.md` and any affected Map spec text.
2. Run full Windows `bun run smoke`.
3. Run complete interactive smoke against the compiled executable.
4. Keep PR #8 draft until checks pass or a remaining item is explicitly deferred.

# Prior Carry-Forward Work — Save for Later

The following predates the current-turn installer fixes. Do not let it block the current implementation pass unless a direct dependency is discovered.

## Historical Map skill/sub-agent orchestration investigation

The earlier intended Map skill/sub-agent architecture remains unresolved.

Before redesigning `skills/map/SKILL.md` around orchestration:

1. Deep-search `jacoblockett/jl-skills` history.
2. Deep-search `jacoblockett/persist` history.
3. Recover or rule out the earlier accepted orchestrator/sub-agent contract.
4. Compare the recovered design with current Map skill/package resources.
5. Do not invent a replacement architecture first.

The old duplicate/recovery-TUI items are not carried forward because the accepted lifecycle no longer has a machine-level Map project registry or global copied-project arbitration flow.

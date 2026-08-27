# Installer + Map UI Smoke Review

Status: active review tracker for the current `spec-installer-lifecycle` pass.

Purpose: preserve unresolved UX, lifecycle, and regression requirements before implementation so the branch can be checked against one current source instead of conversation memory.

This file is review input. Accepted behavior must eventually be reconciled into `INSTALLER_SPEC.md` and, where applicable, `skills/map/SPEC.md`. Do not mark an item resolved merely because code was changed; it must survive the relevant automated and manual smoke checks.

## 1. Navigation footer glyphs and layout

Replace spelled-out key names in prompt footers with compact Unicode key symbols.

Use:

```text
↑/↓  navigate
␠    select        U+2420 SYMBOL FOR SPACE
↵    confirm       U+21B5 DOWNWARDS ARROW WITH CORNER LEFTWARDS
A    toggle all
⌫    back          U+232B ERASE TO THE LEFT
␛    exit          U+241B SYMBOL FOR ESCAPE
```

`␠` is the preferred space glyph. It is the shallow bucket-like Unicode space symbol that was being sought; do not use the Ogham space mark unless rendering proves unusable.

Required presentation:

- Keep all applicable hints on one line.
- Do not split the footer into two rows.
- Use `exit`, not `cancel`, for Escape copy.
- Insert one blank visual line between the last answer choice and the footer so the prompt does not feel cramped.
- Apply the spacing rule consistently to select, multiselect, and binary confirmation prompts.
- Preserve the Clack guide/spine styling.

Example multiselect footer shape:

```text
↑/↓ navigate • ␠ select • ↵ confirm • A toggle all • ⌫ back • ␛ exit
```

Example ordinary single-select/binary footer shape:

```text
↑/↓ navigate • ↵ confirm • ⌫ back • ␛ exit
```

## 2. Standard binary confirmation UI

Do not use the inline Clack `confirm` rendering for final confirmations.

Project-wide confirmation behavior:

- Render `Yes` and `No` as ordinary one-choice-per-line options.
- `Yes` appears first, then `No` on the next line.
- Keep the navigation footer visible under the choices.
- Keep the blank line between the choices and footer.
- Use one consistent confirmation question, preferably `Continue?`, instead of inventing more explicit wording for each action after the user has already chosen that action.
- Destructive actions may retain a safe default/cursor policy where appropriate, but the visible choice order remains Yes then No.
- Back from a confirmation returns exactly one question backward and preserves prior wizard state.

This applies to installation, update, skill uninstall, generated-data deletion, installer update, and installer uninstall confirmations.

## 3. Instruction injection must be per harness and per selected skill

Current implementation is not generalized enough. It currently reduces instruction injection to one boolean that is applied across all selected skills and all selected harnesses.

Replace that model.

Required interactive behavior:

1. User selects skills.
2. User selects one or more AI harnesses.
3. For each selected harness/instruction file, present a multiselect containing only the skills selected in step 1.
4. Ask which of those selected skills should have managed instructions injected into that harness's instruction file.
5. Each such multiselect starts with nothing selected on first entry.
6. Returning to a previously visited harness instruction step restores the prior submitted subset.

Examples:

```text
Which skills would you like to add to AGENTS.md?

[ ] Map
[ ] Another Skill
```

and separately:

```text
Which skills would you like to add to CLAUDE.md?

[ ] Map
[ ] Another Skill
```

The implementation must support the full skill × harness matrix. Do not special-case Map merely because it is currently the only catalog skill.

The installation summary must reflect the actual per-file/per-skill injection choices rather than one global Yes/No state.

Update must preserve the actual managed-block state independently for each installed skill/harness pair unless explicitly changed. Uninstall removes only the managed block for the selected skill/harness pair.

## 4. Note-block title casing and naming

The small title at the top of Clack note blocks should use Title Case unless a specific aesthetic reason requires otherwise.

Required examples:

```text
Installation Summary
Update Summary
Uninstall Summary
Permanent Data Removal
```

Both skill uninstall and installer uninstall use the note title `Uninstall Summary` when a summary note is actually warranted.

Do not use sentence-case note titles such as `Installation summary`, `Update summary`, or `Installer uninstall summary`.

## 5. Installer uninstall UX should be much simpler

The current installer-uninstall summary is overexplained.

Remove the current summary block that always lists:

- installer executable;
- `Installer-owned data: None detected.`;
- a `Preserved` list.

Preferred flow:

- Present a concise warning message such as: `This action will uninstall the jl-skills installer and any associated installer-owned data and tooling.`
- If installer-owned data actually exists, identify the concrete data/path that will also be removed.
- If no installer-owned data exists, do not tell the user that none was detected.
- Do not list obvious preserved items merely to reassure the user.
- Follow the warning with the standard `Continue?` Yes/No selection.
- Do not rewrite the confirmation as `Permanently uninstall the jl-skills installer?` or similarly heightened wording.

The operation should remove only the installer executable and actual installer-owned data/tooling. Installed skills, skill runtime/tooling, and skill-generated project data remain untouched by implementation, but the UI does not need to enumerate that obvious preservation on this screen.

## 6. Add `Update jl-skills installer`

Add a new home-screen action between:

```text
Remove skill-generated data
Update jl-skills installer
Uninstall jl-skills installer
```

The updater implementation is not yet present and needs to be designed and tested.

Target behavior:

- Check the authoritative published installer release/version source.
- Compare the running `VERSION` against the newest compatible installer release.
- If current, report `No updates found.` and return to the home screen.
- If an update is available, show a concise `Update Summary` with the current and target installer versions.
- Use the standard `Continue?` Yes/No prompt.
- Download the replacement to a temporary/sibling path.
- Verify the downloaded artifact before replacement. Prefer a release manifest containing at least version and SHA-256 rather than trusting an unverified binary fetch.
- On Windows, replace the running executable only after the current process exits, using the smallest reliable detached replacement step.
- Preserve installed skills, skill runtime/tooling, and skill-generated project data.
- Do not require the user to redo setup after an installer update.

Release transport/source still needs implementation-level inspection. The eventual public path should be compatible with a normal release endpoint; automated smoke must not depend on a live external network or mutate the real running development installer.

Updater smoke coverage should use a deterministic local fixture/fake update source and verify at least:

- no-update path;
- newer-version detection;
- download/verification success;
- hash/version rejection;
- replacement staging;
- preservation boundaries.

## 7. `Update Skills` pipeline must prove real skill-file ownership

A basic update path exists, but the regression suite must prove the behavior expected from a real catalog skill update rather than merely reapplying the same version.

Required update semantics:

- Discover installed skills from the selected scope/harness filesystem state.
- Compare installed self-reported metadata to the catalog version.
- Update the actual installed `SKILL.md` and every other manifest-declared skill asset for the selected installed harness targets.
- Update declared runtime/support assets where appropriate.
- Preserve each skill/harness instruction-injection choice unless explicitly changed.
- Never add a new harness during Update; adding another harness belongs to Install.
- Never initialize or mutate skill-generated semantic/project data.
- Keep updates scoped to the selected scope and selected skills.

Add a regression that creates an intentionally stale installed skill representation, including older metadata and stale file contents, then runs the updater and verifies that the current catalog contents/version replace it while unrelated files and generated data remain intact.

Where practical, also test multiple selected skills/targets so the updater does not accidentally rely on Map being the only skill.

## 8. Accepted installer invariants that must not regress

Keep these already accepted behaviors while implementing the items above:

- Product/executable name remains `jl-skills` / `jl-skills.exe`.
- Top-level operation selection occurs before scope discovery.
- Scope is inspected only after the operation and scope are chosen.
- Harness detection never widens installation scope.
- Harness picker shows all supported harnesses and starts empty.
- No Clack option `hint` fields are used for detected/recommended/version clutter.
- Keyboard Back returns exactly one question backward.
- Process-local wizard selections/cursors/custom-path text are retained when revisiting the same step and same scope.
- Wizard state does not bleed between unrelated operations or scopes.
- Install remains available for a skill that is present on only some supported harnesses so the user can add it to another harness.
- Installation summaries remain sectioned, compact, and generalized for multiple skills.
- Managed instruction blocks preserve unrelated user content and reject malformed/ambiguous boundaries rather than guessing.
- Skill uninstall preserves skill-generated data and shared runtime/tooling.
- Generated-data deletion remains a separate explicit operation based on the user-selected scope/path, with no whole-drive scan.
- Installer self-uninstall remains installer-only.

## 9. Carry-forward unresolved Map item

The historical Map skill/sub-agent orchestration design is still unresolved and remains separate from this installer UI pass.

Before redesigning `skills/map/SKILL.md` around orchestration:

1. Deep-search `jacoblockett/jl-skills` history.
2. Deep-search `jacoblockett/persist` history.
3. Recover or rule out the earlier accepted orchestrator/sub-agent contract.
4. Compare the recovered design with the current Map skill/package resources.
5. Do not invent a replacement architecture first.

The older duplicate/recovery TUI items from the 2026-08-25 review are not carried forward because the accepted lifecycle no longer has a machine-level Map project registry or global copied-project arbitration flow.

## 10. Current implementation order

Before PR #8 is considered ready:

1. Implement the navigation glyph/footer and spacing changes.
2. Replace all project confirmation prompts with the standard line-oriented Yes/No selector.
3. Generalize instruction injection to per-harness/per-skill selection.
4. Normalize note titles and simplify installer-uninstall UX.
5. Design and implement `Update jl-skills installer` with deterministic updater tests.
6. Strengthen `Update Skills` regression coverage around an actual stale installed skill/version/content.
7. Reconcile accepted behavior into `INSTALLER_SPEC.md`.
8. Run the full Windows `bun run smoke` gate.
9. Run the complete interactive manual smoke against the compiled executable.
10. Keep PR #8 draft until those checks pass or a remaining item is explicitly deferred.

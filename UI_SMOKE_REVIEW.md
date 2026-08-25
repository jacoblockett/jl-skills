# Installer + Map UI Smoke Review

Status: durable review notes from the 2026-08-25 interactive smoke pass on `spec-installer-lifecycle`.

Purpose: preserve every observed UX/architecture issue before implementation so later changes can be checked against one source instead of relying on conversation memory.

This document is review input, not a replacement for `INSTALLER_SPEC.md` or `skills/map/SPEC.md`. Once decisions below are resolved, accepted behavior should be folded into those authoritative specs.

## 1. Harness selection during install

Current observed behavior is not desired.

Required direction:

- Do not preselect all detected harnesses.
- Harness selection should begin with no harnesses selected.
- Provide a `Select all` choice.
- Detected harnesses should be clearly marked as detected.
- Undetected supported harnesses should still be visible and selectable.
- An undetected harness should carry a simple user-facing hint such as `not detected on this computer` rather than being hidden or disabled merely because detection failed.
- Preserve an explicit `Cancel` choice.
- A `Go back` path is also required as described in section 4.

Detection remains informational. It must not widen scope or prevent a user from explicitly targeting a supported harness.

## 2. Pre-install plan copy

The current plan note includes language equivalent to:

```text
Map state: not initialized by installer
```

This is confusing and appears unnecessary in normal user-facing UI.

Required direction:

- Remove this line unless a concrete user-facing purpose is established.
- The installer contract may still prohibit semantic Map initialization, but that implementation/safety invariant does not need to be repeated in ordinary install-plan copy.

## 3. Installed-scope summary visibility

The current installed-skill summary is too easy to miss because it is printed immediately before the next prompt.

Required direction:

- Keep the concise installed-skill summary.
- Make the following question explicitly draw attention to the information above in professional, nontechnical wording.
- Do not make the user infer that a transient block immediately above contains important detected state.

Exact wording remains open, but the UI should make clear that JL-Skills found existing installations at the selected scope before asking what to do next.

## 4. Back vs Cancel semantics

Current cancellation behavior is too destructive to navigation.

The UI needs two distinct concepts:

```text
Go back = return to the previous meaningful question without mutation
Cancel  = abandon the entire CLI operation without mutation
```

Required behavior:

- Add `Go back` where the user is more than one meaningful decision into a wizard and returning to the prior step is useful.
- `Cancel` remains the explicit way to exit the whole operation.
- If a final `confirm` asks whether to continue and the user answers `No`, return to the immediately preceding selection/plan step rather than terminating the entire process.
- The user should not need to restart a five-step wizard because they selected the wrong item one screen earlier.
- Normal wizard mutation should still happen only after the final confirmed plan, so back/cancel paths should not need cleanup in ordinary flows.

## 5. Withdrawn update-harness idea

During review, an idea was raised that update might offer newly detected harnesses that were not part of the existing installation.

That idea was explicitly withdrawn and must **not** be implemented from these notes.

Reason: update should update the installation the user already chose. Installing the skill for another harness belongs to the Install flow.

## 6. Update skill-choice presentation

Current harness hints on each update skill option are considered clutter.

Required direction:

- Do not append `Codex`, `Claude`, etc. to every skill option merely to repeat existing receipt information.
- The user is selecting skills to update, not reconstructing harness targeting.
- Existing harness receipts should continue to determine which integrations are updated unless explicit CLI `--agent` filters are supplied.

Update choices should instead emphasize **version state**.

Required version behavior:

- Before the update picker, compare the installed version recorded in the installer registry with the currently available/catalog version.
- The informational block should make version state visible.
- Each skill option should indicate whether it is already up to date.
- If an update is available, show a concise transition such as:

```text
0.2.0 -> 0.3.0
```

- If no update is available, show a simple hint such as `up to date`.
- An up-to-date skill should remain selectable so the user can intentionally reapply/repair/update its owned resources.
- Update selection begins with nothing selected.

## 7. Instruction injection must be optional

Installing a skill must not force modification of `AGENTS.md`, `CLAUDE.md`, or equivalent ordinary-agent instruction files.

Required direction:

- Add an explicit interactive choice controlling managed instruction injection.
- Users who want JL-Skills to install skill files/runtime support but keep their instruction files untouched must be able to do so.
- The choice should be presented before mutation and reflected in the final plan.
- Installer receipts must accurately represent whether an instruction block was installed so later update/uninstall does not assume ownership that was never granted.
- Update should preserve the user's existing injection choice unless the user explicitly changes it through an appropriate management flow.
- Uninstall removes a managed block only when that installation actually owns one.

This flexibility is considered important for users who maintain carefully controlled agent instructions.

## 8. BLOCKING: Map skill/sub-agent architecture may have regressed

This is the highest-priority architecture concern from the smoke review.

Observed concern:

- The current Map `SKILL.md` appears to have regressed away from the previously intended architecture.
- The intended main skill was described as a dedicated **sub-agent orchestrator** with minimal direct responsibility outside orchestration/control.
- Work such as discovery, summarization, and similar specialized activities was expected to be delegated to installed Map sub-agents.
- Those sub-agents were expected to be installed alongside the main skill.
- The current implementation appears not to contain or prototype those sub-agents.

Required next action before redesigning `SKILL.md`:

1. Deep-search the history of `jacoblockett/jl-skills` for the earlier Map skill/sub-agent architecture.
2. Deep-search the relevant `persist` / spec-persist repository history for the same contract.
3. Recover any durable specification, accepted design, or prior working skill/sub-agent files that established this architecture.
4. Compare that recovered design against the current `skills/map/SKILL.md` and package manifest/resources.
5. Do **not** invent a new orchestration architecture until this historical contract has been recovered or ruled out.
6. If no relevant durable material can be found, stop and tell the user immediately so they can help locate/reconstruct it.

This investigation is intentionally deferred until after this review document is committed. It must not be forgotten merely because recent work focused on installer/runtime/database implementation.

## 9. Exclusive multiselect behavior is not currently working live

The accepted UX called for mutually exclusive sentinel choices such as:

```text
[ ] Map
[ ] Update all
[ ] Cancel
```

Observed behavior:

- Selecting an ordinary item and then selecting `Update all` leaves both visibly selected.
- Both values are submitted/recorded as selected.
- Therefore the intended live exclusive wrapper either was not implemented or is not functioning.

Required direction:

Preferred behavior remains a clean reusable wrapper:

```text
individual selected -> clear All + Cancel
All selected        -> clear individuals + Cancel
Cancel selected     -> clear everything else
```

Constraints remain:

- no Clack fork;
- no monkey-patching;
- no large copied renderer solely for this behavior.

If true live exclusivity cannot be achieved cleanly with Clack 1.7.0, use the previously accepted fallback deliberately and make that limitation explicit. Do not describe the current post-submit behavior as a working exclusive wrapper.

## 10. Remove unnecessary harness language from broad removal flows

Broad removal screens currently expose language such as `Map for Codex` / `Map for Claude` in places where the user has already asked to remove the skill/integration broadly.

Required direction:

- Avoid repeating harness names when they do not help the user's decision.
- Machine-wide or broad skill-removal plans should describe the skill/integration in user terms, not enumerate internal harness receipts unless the user is specifically performing a harness-scoped operation.
- Keep harness detail available where it materially disambiguates an explicitly harness-filtered command.

## 11. Machine-removal follow-up wording

Observed issue:

- After choosing `Remove JL-Skills from this computer`, the next prompt repeats essentially the same phrase as its question text.

Required direction:

- Use an actual follow-up question that advances the decision.
- Avoid title/question duplication that makes the wizard feel mechanically generated.
- Continue using nontechnical wording.

Exact wording is open for revision during the UX pass.

## 12. Selecting Map project data to delete

Current machine-removal behavior lists all known Map project locations and then asks whether all should be deleted.

Preferred behavior:

- Present registered Map project locations as a multiselect so the user can choose exactly which project data to delete.
- Make all registered project locations selected by default, or provide an equivalent `Select all` default that clearly represents the broad removal action the user just requested.
- The user must be able to deselect individual projects they want to preserve.
- Preserve `Go back` and `Cancel` navigation.
- Keep an explicit destructive confirmation after project selection.
- The authoritative Map registry remains the source of the candidate project list; do not scan drives for unregistered `.map` directories.

## 13. Map duplicate/recovery prompts must not use an ad hoc TUI

Observed issue:

- Duplicate-Map and identity-recovery prompts are currently hand-written numbered terminal prompts.
- This is inconsistent with the accepted Clack-based product UI.

Required direction:

- Remove the rolled-own numbered prompt experience.
- Duplicate/recovery interaction should use the accepted JL-Skills prompt framework/visual language.

Architecture caveat to resolve:

- `map.exe` is a native Rust runtime while Clack 1.7.0 is part of the TypeScript/Bun installer stack.
- Therefore simply "use Clack inside Rust" is not a viable implementation assumption.
- Before coding this fix, determine the smallest architecture that preserves the native Map runtime while presenting these user-required recovery decisions through the accepted prompt UX.
- Do not solve the mismatch by maintaining a second bespoke Rust TUI that merely imitates Clack.

## 14. Duplicate-Map wording is ambiguous

Current wording uses concepts like:

```text
This Map
Original
Copy
```

Observed concern:

- `This Map` is ambiguous.
- `Original` and `Copy` may not tell a nontechnical user which physical project is currently being operated on or what each resolution will change.

Required direction:

- Clearly identify the **currently opened project path**.
- Clearly identify the **other registered project path**.
- Explain the effect of each action in terms of those concrete paths.
- Avoid relying on `original` / `copy` labels as the only disambiguation.
- Before destructive deletion, state exactly which project's `.map` data will be removed.
- Before separation, state that the currently opened project will receive a new Map project identity while its existing Map contents remain.

The same clarity principle applies to recovery prompts: say what project/path is being repaired and what will change.

## 15. UI review acceptance checklist

Before PR #8 is considered UI-complete, manually recheck at least:

- install harness picker starts empty;
- detected and undetected supported harnesses are both visible/selectable with appropriate hints;
- Select all works as intended;
- pre-install plan no longer contains unexplained Map-initialization copy;
- installed-scope state is difficult to miss;
- Go back exists at meaningful nested steps;
- `No` on confirmation returns to the prior step;
- Cancel exits the operation;
- update picker shows installed/current available version state;
- up-to-date skills remain selectable;
- harness labels are removed from update options where they add clutter;
- instruction injection can be declined;
- instruction ownership/receipt behavior follows that choice;
- exclusive sentinel behavior works or an explicitly accepted fallback is used;
- broad removal UI does not unnecessarily enumerate harness receipts;
- machine-removal follow-up wording is not repetitive;
- Map project-data deletion uses a selectable registered-project list;
- duplicate/recovery UX no longer uses an ad hoc numbered TUI;
- duplicate/recovery wording names concrete project paths and concrete effects;
- recovered historical Map skill/sub-agent architecture has been reviewed before finalizing skill resources.

## 16. Deferred implementation order

Recommended order after this document:

1. Recover and review the historical Map orchestrator/sub-agent contract.
2. Resolve the Map-runtime-versus-Clack interactive recovery architecture.
3. Update authoritative specs with accepted outcomes from those investigations and the confirmed UI notes above.
4. Implement installer navigation, harness selection, version display, optional instruction injection, removal-project selection, and copy cleanup.
5. Implement/recover Map skill/sub-agent resources according to the recovered contract.
6. Re-run automated smoke tests.
7. Repeat the manual UI branch smoke pass.

Do not merge PR #8 until the review items intended for V1 are either resolved or explicitly deferred by the user.
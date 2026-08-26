# Installer + Map UI Smoke Review

Status: durable review notes from the 2026-08-25 interactive smoke passes on `spec-installer-lifecycle`.

Purpose: preserve every observed UX/architecture issue before implementation so later changes can be checked against one source instead of relying on conversation memory.

This document is review input, not a replacement for `INSTALLER_SPEC.md` or `skills/map/SPEC.md`. Once decisions below are resolved, accepted behavior should be folded into those authoritative specs.

## 1. Harness selection during install

Current observed behavior from the first smoke passes is not desired.

Current accepted direction:

- Do not preselect harnesses.
- Harness selection begins with nothing selected.
- Show every supported harness, whether or not JL-Skills detects it on the machine.
- Do not display detection status or any other option hint in the interactive picker.
- Detection remains an internal implementation detail and may still support deterministic/noninteractive fallback behavior.
- Provide `All of the above`, `Go back`, and `Cancel & Exit` directly in the same harness-selection screen.
- Do not insert an extra `Choose specific harnesses` screen.

Install scope determines where the integration is installed. Harness detection is machine/user-level and must not widen or narrow the selected project/user scope.

## 2. Pre-install plan copy

The original plan note included language equivalent to:

```text
Map state: not initialized by installer
```

This is confusing and unnecessary in normal user-facing UI.

Required direction:

- Remove this line.
- The installer contract may still prohibit semantic Map initialization, but that implementation/safety invariant does not need to be repeated in ordinary install-plan copy.

## 3. Installed-scope summary visibility

The installed-skill summary can be too easy to miss because it is printed immediately before the next prompt.

Required direction:

- Keep the concise installed-skill summary.
- Make the following question explicitly draw attention to the information above in professional, nontechnical wording.
- Do not make the user infer that a transient block immediately above contains important detected state.

## 4. Back vs cancel semantics

The UI needs two distinct concepts:

```text
Go back       = return exactly one question backward without mutation
Cancel & Exit = abandon the entire CLI operation without mutation
```

Required behavior:

- `Go back` means the immediately preceding question, not the preceding major workflow section.
- Example install chain: scope -> skills -> harnesses -> instruction choice -> confirmation.
- Back from skills returns to scope.
- Back from harnesses returns to skills.
- Back from instruction choice returns to harnesses.
- `No` at final confirmation returns to the immediately preceding instruction choice.
- Multiselect screens must include their appropriate `All of the above`, `Go back`, and `Cancel & Exit` choices rather than trapping the user in the selection screen.
- When a user returns to a previously submitted multiselect during the same wizard invocation, restore the selections they previously made rather than presenting that question as blank/default again.
- Retention is wizard-local; a new `jl-skills.exe` invocation starts clean.
- Previously remembered values must be filtered against the current selectable option set so disabled/stale choices cannot be resurrected.
- Normal wizard mutation still happens only after the final confirmed plan.

## 5. Withdrawn update-harness idea

During review, an idea was raised that update might offer newly detected harnesses that were not part of the existing installation.

That idea was explicitly withdrawn and must **not** be implemented.

Reason: update should update the installation the user already chose. Installing the skill for another harness belongs to the Install flow.

## 6. Update skill-choice presentation

Harness names on every update skill option are clutter and should not be shown unless a harness-specific operation actually requires that distinction.

Update choices should emphasize version state.

Required version behavior:

- Before the update picker, compare installed registry version with the bundled/catalog version.
- Make version state visible in the update flow.
- If no update is available, communicate `up to date` without using Clack option hints.
- If an update is available, show a concise transition such as `0.2.0 -> 0.3.0` without using option hints.
- An up-to-date skill remains selectable so the user can intentionally reapply/repair owned resources.
- Update selection begins with nothing selected on first entry; if revisited in the same wizard, restore the prior submitted selection.

## 7. Instruction injection must be optional and understandable

Installing a skill must not force modification of `AGENTS.md`, `CLAUDE.md`, or equivalent ordinary-agent instruction files.

Required direction:

- Add an explicit interactive choice controlling managed instruction injection.
- Users who want skill files/runtime support but want their instruction files untouched must be able to decline it.
- Do not use jargon such as `AI instruction files` without explaining the concrete file and its purpose.
- Keep the clean explanatory note block above the question.
- The following question must explicitly point the user to the information above with short, unobtrusive hint-like text in the question itself so the note is not easy to miss.
- Do not stuff the full explanation into the question body; preserve the compact Clack visual shape.
- Name the applicable files dynamically (`AGENTS.md`, `CLAUDE.md`, or both).
- Explain in plain language that these files contain general instructions the selected AI tool reads automatically.
- Answer choices should be plain `Yes`, `No`, `Go back`, and `Cancel & Exit` with no recommendation hints.
- The choice is reflected in the final installation summary.
- Receipts record actual instruction ownership.
- Update preserves the user's existing choice unless explicitly changed.
- Uninstall removes a managed block only when that installation owns one.

Implementation status: explanatory note restored; the following question includes a short dimmed pointer to the information above.

## 8. BLOCKING: Map skill/sub-agent architecture may have regressed

This remains intentionally deferred for a separate deep historical review.

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

## 9. True live exclusive multiselect behavior is required

The earlier post-submit fallback is no longer acceptable.

Required live behavior:

```text
individual selected -> clear All / Back / Cancel
All selected        -> clear individuals / Back / Cancel
Go back selected    -> clear everything else
Cancel selected     -> clear everything else
```

The visual state must change **when Space is pressed**, before submission, so contradictory selections are never displayed as simultaneously active.

Implementation decision after review of Clack internals:

- Keep `@clack/prompts` 1.7.0 for the overall installer UI.
- Use its exact underlying public `@clack/core` 1.4.3 package for one JL-Skills-owned exclusive multiselect component.
- Do not replace the whole UI framework.
- Do not monkey-patch Clack globally.
- Do not maintain a full Clack fork merely for this policy.
- The component owns only the selection policy/render surface required to enforce JL-Skills exclusivity while retaining Clack's prompt machinery and visual language.
- Automated tests must exercise exclusivity on the live Space/cursor event, not only normalize answers after Enter.

Implementation status: implemented on `spec-installer-lifecycle`; pending Windows smoke/manual UI confirmation.

## 10. No option hints

This supersedes all earlier notes that requested or tolerated Clack option hints.

Required direction:

- Do not use Clack option `hint` text anywhere in the installer UI unless the user explicitly reintroduces a specific option hint later.
- This includes detection hints, recommendation hints, version hints, and generic descriptive hints.
- Information that is actually necessary should be expressed in the main label, prompt wording, summary, or other deliberate UI copy instead of dim parenthetical option-hint clutter.
- Short dimmed explanatory text that is part of a question's message is not an option hint and is allowed when it points to important context immediately above.

Implementation status: installer source contains no `hint:` options; regression coverage guards this.

## 11. Installation summary should read like an action, not implementation state

The earlier key/value dump such as:

```text
Skills: map
AI harnesses: Claude Code, OpenAI Codex
Location: ...
Standing instructions: add skill guidance
```

is not acceptable product copy.

Required direction:

- Use a polished natural-language summary of what will happen.
- Describe the skill, destination, selected AI tools, and concrete instruction-file behavior.
- Do not use vague phrases such as `Standing instructions` or `add skill guidance`.
- Example shape:

```text
Installation summary

Install Map in C:\Projects\Vacation.
Make it available to OpenAI Codex and Claude Code.
Add Map instructions to AGENTS.md and CLAUDE.md.
```

or, if injection was declined:

```text
Leave AGENTS.md and CLAUDE.md unchanged.
```

Implementation status: implemented on `spec-installer-lifecycle`; pending UI confirmation.

## 12. Remove unnecessary harness language from broad removal flows

Broad removal screens should not expose `Map for Codex` / `Map for Claude` when the user has already asked to remove the skill/integration broadly.

Required direction:

- Avoid repeating harness names when they do not help the user's decision.
- Machine-wide or broad skill-removal plans should describe the skill/integration in user terms.
- Keep harness detail only where it materially disambiguates an explicitly harness-filtered operation.

## 13. Machine-removal follow-up wording

After choosing `Remove JL-Skills from this computer`, the next prompt must advance the decision rather than repeat the same phrase.

Required direction:

- Use an actual follow-up question.
- Avoid title/question duplication.
- Continue using nontechnical wording.

## 14. Selecting Map project data to delete

Preferred behavior:

- Present authoritative registered Map project locations as a multiselect.
- For the broad delete-data action, registered locations may begin selected so the broad intent is represented while still allowing individual deselection.
- Include live-exclusive `All of the above`, `Go back`, and `Cancel & Exit` controls.
- Keep an explicit destructive confirmation after project selection.
- Revisited project-selection screens restore the prior submitted subset within the same wizard instead of resetting to all projects.
- Do not scan drives for unregistered `.map` directories.

## 15. Map duplicate/recovery prompts must not use an ad hoc TUI

Observed issue:

- Duplicate-Map and identity-recovery prompts are currently hand-written numbered terminal prompts.
- This is inconsistent with the accepted Clack-based product UI.

Required direction:

- Remove the rolled-own numbered prompt experience.
- Duplicate/recovery interaction should use the accepted JL-Skills prompt visual language.

Architecture caveat to resolve separately:

- `map.exe` is a native Rust runtime while Clack is part of the TypeScript/Bun installer stack.
- Do not assume Clack can simply be imported into Rust.
- Determine the smallest architecture that preserves the native runtime while presenting these user-required decisions through the accepted prompt UX.
- Do not solve this by maintaining a second bespoke Rust TUI that merely imitates Clack.

## 16. Duplicate-Map wording is ambiguous

Required direction:

- Clearly identify the currently opened project path.
- Clearly identify the other registered project path.
- Explain every resolution in terms of those concrete paths.
- Do not rely on `original` / `copy` labels as the only disambiguation.
- Before deletion, state exactly which project's `.map` data will be removed.
- Before separation, state that the currently opened project receives a new Map project identity while its contents remain.
- Apply the same concrete-path clarity to identity recovery.

## 17. UI review acceptance checklist

Before PR #8 is considered UI-complete, manually recheck at least:

- executable/product is consistently `jl-skills` / `jl-skills.exe`;
- install skill picker begins empty on first entry;
- harness picker begins empty on first entry and shows all supported harnesses with no detection hints;
- no installer option hints are present;
- `All of the above` is live-exclusive with individual choices;
- `Go back` and `Cancel & Exit` are live-exclusive with every other choice;
- back navigation returns exactly one question at a time;
- revisiting a previously submitted multiselect restores its prior choices;
- `No` on confirmation returns exactly one question;
- instruction-file explanation remains in a clean note block;
- instruction question clearly points to the information above without duplicating the whole explanation;
- instruction injection can be declined;
- installation summary uses natural action-oriented prose;
- installed-scope state is difficult to miss;
- update flow exposes version state without option hints;
- up-to-date skills remain selectable;
- harness labels are removed from update options where they add clutter;
- broad removal UI does not unnecessarily enumerate harness receipts;
- machine-removal follow-up wording is not repetitive;
- Map project-data deletion uses a selectable registered-project list with live-exclusive navigation/all controls;
- duplicate/recovery UX no longer uses an ad hoc numbered TUI;
- duplicate/recovery wording names concrete project paths and effects;
- recovered historical Map skill/sub-agent architecture has been reviewed before finalizing skill resources.

## 18. Deferred implementation order

Remaining major work after the current installer UI pass:

1. Run the Windows automated smoke and focused manual install UI confirmation.
2. Continue the rest of the installer UI branch review only after the basic install path is accepted.
3. Recover and review the historical Map orchestrator/sub-agent contract.
4. Resolve the Map-runtime-versus-Clack interactive recovery architecture.
5. Fold accepted final UI behavior into authoritative specs.
6. Repeat the complete manual branch smoke.

Do not merge PR #8 until the review items intended for V1 are either resolved or explicitly deferred by the user.

---
name: map
description: Define, clarify, and persist durable user intent in the local Map graph. Use when explicitly invoked as $map; ordinary agents may query Map without invoking this workflow.
---
<!-- jl-skills-meta: {"name":"map","version":"0.5.0","format":1} -->

# Map

Map is the interactive editor for durable intent. It never implements the mapped work.
Use this workflow when the user explicitly invokes `$map` or explicitly asks to start/resume Map clarification.

The authoritative semantic state is the selected `.map` graph. Session state is recovery only.
Never read or modify `.map/db` directly and never use SurrealQL instead of the CLI.

## Runtime invariants

1. Preserve user intent. Never invent requirements, decisions, facts, or rationale.
2. Ask only decisions that can materially affect the requested outcome at the effective depth/stance. Prefer safe inference and downstream freedom over interrogation.
3. Five questions is a cap, never a quota.
4. Facts are contextual evidence; decisions are choices. Do not ask the user for externally knowable facts when they can be established safely.
5. Children run serially. Consume and close each child before spawning another. Children never spawn children.
6. Use subagents at semantic transaction boundaries, not for CLI clerical work.
7. Spawn prompts contain only dynamic arguments/evidence. The installed agent definition owns its semantic contract.
8. One semantic repair cycle maximum per reviewed transaction. No reviewer/worker ping-pong.
9. Persist recovery state before exposing resumable work. Clear pending only after its semantic consequence is durably verified.
10. `explored` and `closed` are explicit. Never infer either from question count.
11. Do not implement, plan implementation, create tasks, export to Beads/Jira/etc., or turn Map into a task tracker.

## Required specialists

`jl-skills` installs seven Map specialists as native subagents for the selected harness:

- `map-state-writer`
- `map-state-reviewer`
- `map-discovery`
- `map-discovery-reviewer`
- `map-linguist`
- `map-context`
- `map-completion-auditor`

For each specialist stage, spawn one fresh child using the exact registered specialist name. The installed subagent definition owns its semantic contract; the parent prompt supplies only the dynamic arguments/evidence required by that stage. Do not spawn a generic child and ask it to load a role file from this skill, and do not inline, paraphrase, or expand the specialist contract into the parent prompt. Close the child after consuming its result.

If a required named specialist cannot run, fail that stage closed. Do not replace its semantic judgment with the parent thread.

Normal fresh flow with no external context need should normally use three children before questions: State Writer, Discovery, Discovery Reviewer. Linguist is a fourth child only when needed.

## CLI

Use the installer-provisioned CLI:

```text
{{JL_MAP_CLI}}
```

Global form:

```text
{{JL_MAP_CLI}} [--path PATH] [--config PATH] <command>
```

Use `status`, `context`, `show`, `get`, `search`, `history`, and `validate` for reads. Use `--help` for exact command flags instead of memorizing unnecessary grammar.

Normal commands require an existing Map. Do not initialize one merely because the skill is installed.

## Start or resume

1. Resolve the intended Map and run `status` when one exists.
2. If a recovery session exists, inspect session pending/exchange plus authoritative graph state before doing unrelated new Map work. Never blindly replay pending work.
3. Briefly state your understanding of the requested outcome and effective `mvp|thorough` depth plus `normal|adversarial` stance. Ask for correction/confirmation before first authoritative mutation for a new direction.
4. If no Map exists and the user confirms they are starting one here, run `init`. Do not initialize any other path by inference.
5. Ensure a session exists for substantive Map conversation. Record exact user/assistant exchanges as required by the session-first persistence invariant.

If the user is only querying an existing Map rather than editing/clarifying it, answer from read-only Map state and do not start the full discovery workflow unnecessarily.

## Optional context transaction

Use `map-context` only when repository/environment/external context materially affects the focused intent.
Pass the exact authorized context scope and focus. Reuse its compact report for the current semantic transaction.
Skip it when Map state and user evidence are sufficient.

Context evidence may establish facts. It never silently becomes user intent.

## Baseline semantic transaction

Before Discovery, confirmed concrete direction must exist as durable Map semantic state.

For a new direction or a material direction correction:

1. Persist the recovery checkpoint first.
2. Spawn `map-state-writer` with `MODE: BASELINE` or `MODE: DIRECTION_CORRECTION`, Map path, confirmed source evidence, and optional context report.
3. Close it.
4. Run `validate` and inspect the affected intent/context.
5. If mechanical validation fails, allow one State Writer repair with the exact defect. If it still fails, stop and report the blocker.

Normal baseline does not use State Reviewer. Concrete confirmed direction must produce at least one durable intent unless doing so would require inventing the user's objective.

## Discovery batch

For each focused non-closed intent needing exploration:

1. Read its compact `context` and effective depth/stance.
2. Spawn `map-discovery` once with Map path, focus intent IDs, optional context report, and optional audit focus.
3. Close it.
4. Spawn `map-discovery-reviewer` once with the whole candidate batch and exhaustion claim.
5. Close it.
6. Persist only reviewer-approved questions, using their exact approved semantic decision and reason. Do not create nodes for rejected/duplicate/already-settled candidates.
7. If wording help is requested by Reviewer, run `map-linguist` once for that subset and use its returned wording exactly.
8. Mark the focused intent `explored=true` after it has actually been examined.
9. Before presenting questions, append the exact assistant message to session exchange and set session pending to the question IDs/text being exposed.
10. Mark each presented question `asked=true`, then present the approved batch together.

Discovery standards:
- material ambiguity only
- no arbitrary quota
- semantic duplicates do not become new questions
- dependent questions wait for prerequisites
- optional capabilities default out once direction is concrete
- postponable implementation choices stay open
- adversarial stance challenges assumptions rather than merely increasing question count
- `EXHAUSTED` means no additional worthwhile decision belongs in the current pass; fewer than five is correct

If zero candidates are approved and Reviewer rejects exhaustion, allow one focused Discovery+Reviewer retry. If the same gap remains, surface that gap instead of looping.

## Answers and semantic persistence

When the user answers:

1. Append the exact user message to session exchange. Keep pending intact.
2. Preserve the approved question text, materially relevant clarification, and user answer without strengthening or generalizing it.
3. Spawn `map-state-writer` with `MODE: DECISIONS`, the exact evidence packet, Map path, and optional context report.
4. Close Writer. Spawn `map-state-reviewer` once with the same evidence plus Writer's affected IDs/result.
5. Close Reviewer.
6. On PASS, run `validate`, verify affected context, update the session summary, and clear only pending work whose semantic consequence is durable.
7. On FAIL, allow one fresh Writer+Reviewer repair using the original evidence plus exact deficiencies. If it fails again, stop and report the defects with pending intact.
8. Return to Discovery using refreshed Map state.

User decisions use user provenance. Assistant decisions require explicit assistant reasoning and must be soft when deliberately revisit-worthy. Never hide assistant inference as a user decision.

## Completion

When reviewed Discovery is exhausted and no current unanswered material question remains for the focused intent, spawn `map-completion-auditor` once.

- PASS: mechanically attempt `map set <intent> close true` for each auditor-approved focus intent. Runtime closure invariants remain authoritative.
- FAIL: allow one focused Discovery batch using the auditor's unresolved material areas. If the same blocker remains, surface it.

Closing an intent is not permanent. Later requirements may reopen affected state through normal Map semantics.

## Parent-owned mechanics

The parent owns CLI bookkeeping that does not require fresh semantic judgment:

- path/status resolution
- session init/exchange/summary/pending/end bookkeeping
- exact persistence of reviewer-approved questions
- stable returned IDs and command-result tracking
- `asked`, `explored`, and auditor-approved `close` operations when their semantic precondition was established by the workflow
- validation and exact readback
- retry counting
- serial child lifecycle

The parent must not replace Discovery, Reviewer, Linguist, State Writer/Reviewer, Context, or Completion Auditor semantic work with its own improvised substitute.

## Recovery invariant

For substantive Map conversation:

```text
A. Persist recovery state first.
B. Apply and verify semantic mutations.
C. Clear pending only after B is durable.
```

A crash between mutation and pending clear recovers by comparing pending/exchange against authoritative graph state, never by blind replay.

## Completion boundary

Map clarification for an intent is complete when its effective depth/stance has been genuinely explored, no material current question remains unresolved, runtime closure invariants hold, and `closed=true` succeeds.

Sufficient definition is the target, not maximal specification.

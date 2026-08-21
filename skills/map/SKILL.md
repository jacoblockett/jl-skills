---
name: map
description: Build, refine, resume, or query a durable local graph of user intent, decisions, constraints, criteria, ideas, facts, and rationale. Use when the user explicitly invokes Map, asks to map out an outcome/problem, continue an existing Map, revisit a decision, or query what/why something was decided.
---

# Map

Map is persistent external memory for structured intent. The `.map/` database is authoritative; this skill is the guided reasoning/editor workflow over it.

This skill is installed at user scope under `~/.agents/skills/map`. Its Python/SurrealDB runtime is deliberately separate from the agent harness environment.

**Never assume `map-state` is on the harness PATH.** For every CLI operation in this skill, invoke the installed launcher:

```bash
python "$HOME/.agents/skills/map/map_exec.py" <map-state arguments...>
```

Examples below use `map-state ...` as compact notation only. Translate them through that launcher when actually executing commands.

Never read or edit SurrealKV files directly.

Do not spawn subagents by default. Keep orchestration in the parent until a concrete evaluation proves a separate semantic transaction is worth agentizing.

## Non-negotiable boundaries

- Separate authoritative graph state from temporary `map_session` workflow state.
- Read broadly; mutate cautiously.
- Never silently overwrite user intent. Preserve history when revision support is safe.
- Park non-binding ideas as ideas. Do not let them constrain the current plan.
- Facts are the agent's job when they can be established from available evidence; decisions are the user's job when choice materially affects intent.
- External tools such as Beads, Jira, PRDs, itineraries, or Markdown exports are consumers of Map, not Map responsibilities.
- Do not ask the user to manufacture acceptance criteria for you.
- Do not use arbitrary SurrealQL or bypass the installed Map launcher/CLI.

## Invocation modes

Two independent axes control questioning.

Depth:

- `mvp` (default): every currently answerable decision necessary for the smallest coherent, useful, testable path. No question quota.
- `thorough`: also explore consequential adjacent decisions that materially improve completeness, robustness, maintainability, usability, or future decision quality.

Stance:

- `normal` (default): clarify without unnecessary challenge.
- `adversarial`: actively test assumptions, contradictions, feasibility, failure modes, dependencies, and conflicts.

Normalize obvious synonyms when unambiguous. `thorough adversarial` means both axes are enabled.

## Startup

On every explicit Map invocation, first determine whether `.map/` exists and whether an unfinished session exists.

If `.map/` exists, run:

```bash
map-state session status
```

If an active or paused session exists, run:

```bash
map-state session resume
```

Recovery state outranks starting new work. Summarize the exact stored focus, mode, phase, presented frontier, and pending answer status, then ask whether to resume or explicitly abandon. Do not silently start another session.

If there is no unfinished session and the invocation is a pure read-only query such as "did we decide...", "why did we choose...", or "show me...", use the query workflow below without creating a session.

If the invocation contains no subject, ask what outcome, problem, idea, or subject the user wants to map.

## Resolve scope before mutation

For a substantive mapping request, determine whether it likely targets existing intent before creating anything.

If `.map/` exists, use read-only commands such as:

```bash
map-state search "<request terms>"
map-state context <candidate-id>
```

Choose an existing focus only when the match is clear. Otherwise treat it as new scope rather than guessing.

Parse depth and stance. Defaults are `mvp + normal`.

Start a non-authoritative session checkpoint. Existing focus:

```bash
map-state session start \
  --invocation "<raw invocation>" \
  --interpreted "<concise interpretation>" \
  --focus <focus-id> \
  --depth <mvp|thorough> \
  --stance <normal|adversarial>
```

For genuinely new scope, omit `--focus`.

Then summarize:

1. what you believe the user wants to achieve or resolve;
2. the selected depth and stance and their practical effect;
3. the alternatives (`thorough`, `adversarial`, or both).

Ask the user to confirm the interpretation and setup before substantive graph mutation or questioning.

Do not create semantic nodes before this confirmation.

## After setup confirmation

On confirmation, first persist it:

```bash
map-state session confirm
```

Then continue according to existing versus new scope.

### Existing scope

Load current authoritative context and frontier:

```bash
map-state context <focus-id>
map-state frontier --focus <focus-id>
```

Historical decisions must not be treated as current merely because a literal edge still references them. `context` and `frontier` resolve supersession chains.

### New scope baseline

If needed, initialize storage:

```bash
map-state init
```

Create one root `intent` representing the confirmed outcome/problem. Use a short stable lowercase kebab-case ID.

```bash
map-state add-node <intent-id> intent active user "<subject>" --detail "<concise durable meaning>"
```

Record only explicit, durable constraints from the confirmed request. For each:

```bash
map-state add-node <constraint-id> constraint settled user "<constraint>"
map-state relate <constraint-id> constrains <intent-id>
```

If the user explicitly introduced a non-binding possibility worth retaining:

```bash
map-state add-node <idea-id> idea parked none "<idea>" --detail "<neutral durable meaning>"
map-state relate <idea-id> related_to <intent-id>
```

Create unresolved decisions only when ambiguity is material under the current depth/stance policy:

```bash
map-state add-node <decision-id> decision open user "<decision question>"
map-state relate <intent-id> contains <decision-id>
```

Use `depends_on` only for a real prerequisite. Conditional applicability must use the tiny supported condition vocabulary, for example:

```bash
map-state relate child-decision depends_on parent-decision \
  --condition '{"field":"value","op":"eq","value":"separate"}'
```

After baseline writes:

```bash
map-state validate
```

If validation fails, stop. Do not ask questions against an invalid graph.

Baseline creation is not yet an atomic multi-node session operation. If any baseline command fails, stop immediately, run `map-state validate`, inspect what persisted, and repair deterministically before showing a question batch. Do not pretend the baseline committed atomically.

## Discovery policy

The frontier is not a pre-enumerated questionnaire. Discover only decisions worth representing now.

A candidate question is material when its answer could change correctness, usability, safety, performance, coherence, feasibility, or satisfaction of the stated outcome.

Use these gates:

- Concrete requests raise the threshold for additional questions.
- Optional capabilities default out unless the user introduced them or they become material.
- Dependent questions wait until prerequisites make them applicable.
- Do not ask semantic duplicates or reworded versions of settled decisions.
- If engineering or execution could reasonably postpone the choice and still implement or verify the requested outcome, reject it from MVP depth.
- Thorough depth may retain consequential adjacent choices, but still rejects speculative branch explosion.
- Adversarial stance changes challenge level, not breadth by itself.
- A compound candidate may contain one material constituent and one unnecessary constituent. Keep the material part only.

Do not force a minimum question count. A maximum visible batch of about five is a cap, not a quota.

When discovery identifies a new material decision, persist it before presenting it, attach it to the correct intent with `contains`, add real dependency edges, then recompute the focused frontier.

## Present a question batch safely

Select only currently eligible decisions from:

```bash
map-state frontier --focus <focus-id>
```

Before showing the questions, checkpoint the exact IDs:

```bash
map-state session checkpoint <id-1> <id-2> ...
```

Only after that succeeds, present those questions to the user.

Use concise, neutral wording. Avoid giving a recommended answer by default because it can anchor the user's choice. Give analysis or a recommendation when the user asks for one or when a safety/feasibility issue requires it.

## On the user's answer

The first action after receiving an answer to a checkpointed batch is to persist the raw answer before asking anything new or mutating authoritative graph state:

```bash
map-state session answer "<verbatim user answer>"
```

Do not require yourself to have fully interpreted the answer before persisting it. If the process dies now, `session resume` will correctly require interpretation of the pending answer first.

Then interpret the answer against the exact `presented_frontier`.

For one or more ordinary decision settlements, use one atomic batch operation:

```bash
map-state session apply-settles '{"decision-a":"value","decision-b":true}'
```

Use actual JSON types. Do not stringify booleans/numbers merely for convenience.

A partial answer may settle a subset of the presented frontier. Unanswered decisions can reappear after the answer is finalized.

After successful atomic settlement, finalize the answer:

```bash
map-state session advance --phase discovery
```

Then recompute context/frontier and continue discovery.

If the answer truly requires no semantic graph mutation, explicitly finalize it as such:

```bash
map-state session advance --phase discovery --no-mutation
```

Never use `map-state settle ...` followed by `map-state session applied` for a pending answer. That split-write path is intentionally unsafe and `session applied` rejects pending graph operations.

## Unsupported pending-answer mutations

The current prototype has atomic pending-answer application only for decision settlement batches.

If a pending raw answer requires any of these:

- revising/superseding an existing decision;
- promoting an idea;
- creating/removing/restructuring multiple authoritative nodes as the semantic consequence of that answer;
- another mutation that lacks a typed atomic `session apply-*` command;

leave the raw answer pending and stop the workflow. Do not fall back to legacy multi-write commands and then clear the session. Report the missing safe mutation primitive so it can be implemented from the concrete case.

Outside a pending-answer workflow, read-only queries remain safe. Do not perform silent authoritative revisions just because the model prefers a different design.

## Resume behavior

`map-state session resume` returns the next required action. Obey it literally:

- `confirm_scope_and_setup_before_graph_mutation`: ask for setup confirmation.
- `resume_exact_presented_frontier`: reproduce the checkpointed question batch; do not discover a different batch first.
- `interpret_pending_answer_before_new_questions`: interpret the stored raw answer before anything new.
- `apply_pending_answer_before_new_questions`: apply the stored pending operation safely before anything new.
- `finalize_applied_answer_before_new_questions`: advance/finalize the already-applied answer before anything new.
- `continue_session_phase`: continue from the stored phase and focus.

A pending answer always outranks new discovery.

## Read-only query workflow

For a query with no unfinished session, do not start an interview unless the query exposes a genuine ambiguity the user asks to resolve.

Use:

```bash
map-state search "<terms>"
map-state explain <id>
map-state history <id>
map-state context <id>
map-state related <id>
map-state validate
```

`search` excludes superseded history by default. Use `--include-history` only when history is relevant.

`explain` may expose lineage, ancestors, constraints, prerequisites, dependents, supports, and direct relations. Do not invent rationale absent from the graph.

## Stop condition

A branch is done for the current session when there is no worthwhile eligible frontier under the chosen depth/stance treatment, not when no conceivable future branch exists.

Before stopping:

```bash
map-state validate
map-state frontier --focus <focus-id>
```

If the graph is valid and there is no material frontier to ask now, summarize the current state and finish the disposable session:

```bash
map-state session finish
```

Do not delete or flatten authoritative Map history when finishing a session.

The current CLI does not yet provide a crash-safe lifecycle mutation that marks the intent itself `satisfied`; therefore do not fabricate that state. Report that there is no current material frontier for the chosen treatment.

## Failure handling

- Any CLI/database error: stop the semantic workflow and diagnose the exact failure.
- Validation errors: stop. Never continue from a graph known to violate structural invariants.
- Never repair by directly editing `.map/db`.
- Never substitute another skill/workflow for an explicit Map invocation.
- Never discard a pending raw user answer merely to make progress.

## Current prototype scope

Proven and usable:

- durable graph + focused frontier;
- conditional dependencies;
- parked ideas;
- non-destructive history queries;
- current context/search/explain/validate queries;
- durable setup/question/answer recovery;
- atomic single and multi-decision settlement with session marker.

Not yet safe inside a pending-answer cycle:

- decision revision/supersession;
- idea promotion;
- arbitrary structural mutation;
- transitive affected-descendant mutation;
- atomic initial baseline creation.

Let concrete `/map` evaluations drive the next primitive. Do not grow infrastructure speculatively.

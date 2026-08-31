# Map runtime

Map is a local durable intent graph used by agents and humans through the `map` CLI.

V2 is a clean Rust rewrite. The previous Python runtime/ontology is obsolete and intentionally unsupported for compatibility.

## Build and test

Map source development requires Rust 1.89+:

```bash
cargo test --manifest-path skills/map/Cargo.toml
cargo build --manifest-path skills/map/Cargo.toml --release
```

The runtime embeds SurrealDB/SurrealKV and requires no daemon or listening port.

The current pre-stable release/smoke implementation is Windows x64 only. `bun run build` builds release `map.exe`, stages the declared Map payload, generates the release package/manifest, and compiles the TypeScript + `@clack/prompts` installer with Bun into a standalone Windows executable. The first Stable release is blocked until the target-aware Windows/Linux/macOS matrix and explicit architecture-qualified artifact naming in the repo-level `TODO.md` are complete.

Run the full Map + installer regression smoke with:

```bash
bun run smoke
```

On a supported release target, consumers need only the downloaded standalone installer and the AI harness(es) they intend to target. They do not need Rust, Cargo, Bun, Node, npm, Go, Python, or a SurrealDB server.

Map tooling is local to the selected installation scope and shared only among harness integrations for Map at that same scope:

```text
user scope
  ~/.jl-skills/map/bin/map[.exe]
  ~/.jl-skills/map/schema.surql

project/custom scope
  <scope>/.jl-skills/map/bin/map[.exe]
  <scope>/.jl-skills/map/schema.surql
```

The `.exe` suffix applies only on Windows.

Project/path installs do not provision Map tooling under the user's home directory. Removing the final Map harness integration from a scope removes that scope's `.jl-skills/map` tooling directory; generated `.map` project data is separate and preserved.

## Initialization

Installing Map does not create project `.map` state. The first explicit runtime initialization does:

```bash
map --path /path/to/project init
```

The installed runtime resolves `schema.surql` from its own scope-local tooling directory automatically. During direct source development, `--schema skills/map/schema.surql` may be supplied explicitly when needed.

Normal commands reject when the selected target has no `.map`.

## V2 model

Node kinds:

```text
intent
question
decision
idea
fact
```

Questions are unresolved questions. Decisions are actual answers/choices. Answers are typed question-to-decision relationships rather than values stored on question nodes.

Internal typed relation tables:

```text
contains
answers
depends_on
fact_context
idea_context
```

`map relate` and `map unrelate` infer the legal relation from endpoint kinds and `--dependent`.

## Main CLI

```text
map [--path PATH] [--config PATH] init [--schema PATH]
map create intent <intent> [--context CONTEXT] [--depth DEPTH] [--stance STANCE]
map create question <question> --intent <intent-id> [--reason REASON]
map create decision <decision> [--question ID] [--source user|assistant]
    [--assistant-reasoning REASONING] [--notes NOTES] [--soft]
map create idea <idea>
map create fact <fact> [--made-by user|assistant]
map relate <source> <target...> [--dependent]
map unrelate <source> <target...> [--dependent]
map set depth <mvp|thorough>
map set stance <normal|adversarial>
map set <id> <property> <value>
map replace <old> <new> --reason REASON [--in-place]
map abandon <id> --by user|assistant --reason REASON
map delete <id...> [--force]
map get intents ...
map get questions ...
map get decisions ...
map get ideas ...
map get facts ...
map show <id...>
map context <id>
map status
map validate
map search <query> [--limit N] [--include-history]
map history <id> [--limit N]
map session ...
```

Run `map <command> --help` for exact flags.

## Discovery state

Each Map stores `depth` and `stance`. An intent may optionally store fields with the same names; when present they override the Map values.

`explored` and `closed` are separate:

- `explored=true`: an LLM has examined/reasoned about the intent at least once.
- `closed=true`: the intent is finalized enough for the effective depth/stance and closure invariants currently hold.

The runtime never infers `explored` from question count. New unresolved structure can reopen a closed intent without changing `explored`.

## Question retrieval

`map get questions` returns current non-abandoned unanswered dependency-ready questions by default.

Use:

```text
--include-blocked   also include unanswered dependency-blocked questions
--answered          also include answered questions
--abandoned         also include abandoned questions
```

## Replacement, abandonment, deletion

Normal replacement preserves history:

```bash
map replace OLD NEW --reason "..."
```

`--in-place` is destructive: NEW assumes OLD's graph position and OLD is removed.

Abandonment preserves the node as discarded semantic history. Physical delete removes records. Delete rejects when relationships would be affected unless `--force` is explicitly supplied; force removes selected nodes and incident edges only, never recursive neighbors.

## Validation

```bash
map validate
```

Validation is read-only and non-repairing. It checks node shape, legal relation combinations, cycles, answer cardinality, replacement history, closure invariants, and other graph consistency rules.

## Recovery session

```text
map session init
map session summary [new_summary]
map session exchange [-u MESSAGE | -a MESSAGE] [--depth N]
map session pending [new_pending | --clear]
map session end [--force]
```

Session state is crash/context-loss recovery only. Semantic graph state remains authoritative.

## Tests

The v2 runtime suite exercises the public binary across separate processes against real embedded SurrealKV state:

```bash
cargo test --manifest-path skills/map/Cargo.toml
```

The current installer regression suite exercises project and user scope, scope-local runtime isolation, existing Map preservation, managed-instruction injection/idempotency/boundaries, native subagent placement, uninstall cleanup, and user-scope safety. Run it together with the runtime suite and a clean standalone build using:

```bash
bun run smoke
```

The durable Map contract lives beside the implementation in `skills/map/SPEC.md`. The repo-wide installer contract lives at `INSTALLER_SPEC.md`.

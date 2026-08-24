# Map runtime

Map is a local durable intent graph used by agents and humans through the `map` CLI.

V2 is a clean Rust rewrite. The previous Python runtime/ontology is obsolete and intentionally not supported for compatibility.

## Build

Requires Rust 1.89+.

```bash
cargo build --manifest-path skills/map/Cargo.toml --release
```

Binary:

```text
skills/map/target/release/map
skills/map/target/release/map.exe   # Windows
```

The runtime embeds SurrealDB/SurrealKV. It does not require a SurrealDB daemon or listening port.

## Initialize a test Map

`init` intentionally does not silently locate the repository schema. Until installer/runtime packaging places the schema at its installed location, pass it explicitly during development:

```bash
./target/release/map --path /path/to/project init --schema schema.surql
```

Normal commands reject when the resolved target has no `.map`.

## V2 model

Node kinds:

```text
intent
question
decision
idea
fact
```

Questions are unresolved questions. Decisions are actual answers/choices. Answers are represented by a typed question-to-decision relationship; they are not values stored on question nodes.

Internal relation tables are typed even though callers do not name relations:

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

The v2 test suite is intended to exercise the built public binary across separate processes against real embedded SurrealKV state.

```bash
cargo test --manifest-path skills/map/Cargo.toml
```

The durable product contract is maintained separately in `jacoblockett/persist/map/SPEC.md`.

# Map runtime

Map is a local durable intent graph used by agents and humans through the `map` CLI.

V2 is a clean Rust rewrite. The previous Python runtime/ontology is obsolete and intentionally unsupported for compatibility.

## Build and test

Requires Rust 1.89+.

```bash
cargo test --manifest-path skills/map/Cargo.toml
cargo build --manifest-path skills/map/Cargo.toml --release
```

The runtime embeds SurrealDB/SurrealKV and requires no daemon or listening port.

The consumer installer is built separately from repository root with the Vite-compatible Clack prompt stack:

```bash
npm install
npm run build
```

That build produces a self-contained `build/jl-skill.exe` and embeds the release `map.exe`. Consumers do not need Rust or Node to run the released installer.

## Initialization

Installing Map does not create project `.map` state. The first explicit runtime initialization does:

```bash
map --path /path/to/project init
```

The installed runtime resolves its packaged default schema automatically. During direct source development, `--schema skills/map/schema.surql` may be supplied explicitly when needed.

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
map get intents|questions|decisions|ideas|facts ...
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

Each Map stores `depth` and `stance`. An intent may optionally override either field.

`explored` and `closed` are separate:

- `explored=true`: an LLM has examined/reasoned about the intent at least once.
- `closed=true`: the intent is finalized enough for the effective depth/stance and closure invariants currently hold.

New unresolved structure can reopen a closed intent without changing `explored`.

## Question retrieval

`map get questions` returns current non-abandoned unanswered dependency-ready questions by default.

Use:

```text
--include-blocked   also include unanswered dependency-blocked questions
--answered          also include answered questions
--abandoned         also include abandoned questions
```

## Replacement, abandonment, deletion

Normal replacement preserves history. `--in-place` is destructive: the replacement assumes the old node's graph position and the old node is removed.

Abandonment preserves discarded semantic history. Physical delete removes records and rejects when relationships would be affected unless `--force` is explicit; force removes selected nodes and incident edges only.

## Validation

`map validate` is read-only and non-repairing. It checks node shape, legal relation combinations, cycles, answer cardinality, replacement history, closure invariants, and other graph consistency rules.

## Recovery session

```text
map session init
map session summary [new_summary]
map session exchange [-u MESSAGE | -a MESSAGE] [--depth N]
map session pending [new_pending | --clear]
map session end [--force]
```

Session state is crash/context-loss recovery only. Semantic graph state remains authoritative.

The durable product contract is maintained separately in `jacoblockett/persist/map/SPEC.md`.

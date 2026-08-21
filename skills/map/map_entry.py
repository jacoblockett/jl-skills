"""CLI compatibility entrypoint for the /map prototype.

The SurrealDB Python SDK stringifies record IDs that require escaping as
``node:⟨some-id⟩``. The state engine sometimes round-trips those display strings
back into RecordID objects. Normalize that representation before delegating to
map_state so hyphenated IDs resolve to their original records.

This compatibility layer is intentionally small and should disappear when the
prototype is refactored into a package with record IDs kept typed internally.
"""

from __future__ import annotations

from typing import Any

from surrealdb import RecordID

import map_state


def normalized_rid(node_id: Any) -> RecordID:
    if isinstance(node_id, RecordID):
        return node_id

    text = str(node_id)
    if text.startswith("node:"):
        text = text.split(":", 1)[1]

    # SurrealDB renders string record IDs requiring escaping with angle brackets.
    # This prototype only creates simple string IDs, so stripping that wrapper is
    # sufficient and prevents accidentally looking up a literal "⟨id⟩" record.
    if text.startswith("⟨") and text.endswith("⟩"):
        text = text[1:-1]

    return RecordID("node", text)


def main(argv: list[str] | None = None) -> int:
    map_state.rid = normalized_rid
    return map_state.main(argv)

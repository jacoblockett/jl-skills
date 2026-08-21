"""CLI compatibility entrypoint for the /map prototype.

The SurrealDB Python SDK stringifies record IDs that require escaping as
``node:⟨some-id⟩``. The state engine sometimes round-trips those display strings
back into RecordID objects. Normalize that representation before delegating.

This module routes ordinary-agent read/query commands and durable workflow-session
commands while prototype graph mutation commands remain in map_state.
"""

from __future__ import annotations

import sys
from typing import Any

from surrealdb import RecordID

import map_agent_query
import map_query
import map_session
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


def command_name(argv: list[str]) -> str | None:
    """Find the top-level command while tolerating --root before it."""
    skip_next = False
    for token in argv:
        if skip_next:
            skip_next = False
            continue
        if token == "--root":
            skip_next = True
            continue
        if token.startswith("--root="):
            continue
        if token.startswith("-"):
            continue
        return token
    return None


def without_command(argv: list[str], command: str) -> list[str]:
    """Remove the first top-level command token before delegating to a nested parser."""
    result = list(argv)
    try:
        result.remove(command)
    except ValueError:
        pass
    return result


def print_combined_help() -> None:
    map_state.build_parser().print_help()
    print("\nread-only agent queries:")
    print("  history <id>   Show full supersession lineage and current revision")
    print("  context <id>   Show compact current-state context for a branch")
    print("  related <id>   Show directly adjacent semantic relations")
    print("  validate       Check graph structural invariants without mutation")
    print("  search <text>  Search current Map nodes by stored semantic text")
    print("  explain <id>   Show graph-supported context for one node")
    print("\ndurable workflow continuity:")
    print("  session ...    Start, confirm, checkpoint, recover, and finish /map sessions")


def main(argv: list[str] | None = None) -> int:
    map_state.rid = normalized_rid
    args = list(sys.argv[1:] if argv is None else argv)
    command = command_name(args)
    if command in map_query.QUERY_COMMANDS:
        return map_query.main(args)
    if command in map_agent_query.QUERY_COMMANDS:
        return map_agent_query.main(args)
    if command == map_session.SESSION_COMMAND:
        return map_session.main(without_command(args, command))
    if command is None and any(token in {"-h", "--help"} for token in args):
        print_combined_help()
        return 0
    return map_state.main(args)

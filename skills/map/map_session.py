"""Durable workflow/session state for the /map prototype.

Session records are deliberately separate from authoritative graph nodes. This module
models confirmation, exact frontier checkpoints, raw-answer persistence, and recovery
priority without attempting to make the conversational /map skill itself yet.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from surrealdb import RecordID

import map_state


SESSION_ID = RecordID("map_session", "current")
SESSION_COMMAND = "session"


def get_session(db: Any) -> dict[str, Any] | None:
    value = db.select(SESSION_ID)
    if isinstance(value, list):
        return value[0] if value else None
    return value


def require_session(db: Any) -> dict[str, Any]:
    session = get_session(db)
    if not session:
        raise ValueError("No current Map session")
    return session


def node_ids(values: list[str]) -> list[RecordID]:
    return [map_state.rid(value) for value in values]


def session_summary(db: Any, session: dict[str, Any]) -> dict[str, Any]:
    frontier_nodes: list[dict[str, Any]] = []
    for record_id in session.get("presented_frontier", []) or []:
        node = map_state.get_node(db, str(record_id))
        if node:
            frontier_nodes.append({
                "id": node["id"],
                "state": node.get("state"),
                "subject": node.get("subject"),
            })
        else:
            frontier_nodes.append({"id": record_id, "missing": True})

    focus_nodes: list[dict[str, Any]] = []
    for record_id in session.get("focus_nodes", []) or []:
        node = map_state.get_node(db, str(record_id))
        if node:
            focus_nodes.append({"id": node["id"], "kind": node.get("kind"), "subject": node.get("subject")})
        else:
            focus_nodes.append({"id": record_id, "missing": True})

    result = {
        "id": session["id"],
        "status": session.get("status"),
        "phase": session.get("phase"),
        "depth": session.get("depth"),
        "stance": session.get("stance"),
        "setup_confirmed": session.get("setup_confirmed", False),
        "raw_invocation": session.get("raw_invocation"),
        "interpreted_request": session.get("interpreted_request"),
        "focus_nodes": focus_nodes,
        "presented_frontier": frontier_nodes,
        "pending_user_answer": session.get("pending_user_answer"),
        "pending_operation": session.get("pending_operation"),
        "pending_operation_applied": session.get("pending_operation_applied", False),
        "created_at": session.get("created_at"),
        "updated_at": session.get("updated_at"),
    }
    return {key: value for key, value in result.items() if value is not None}


def resume_action(session: dict[str, Any]) -> str:
    answer = session.get("pending_user_answer")
    applied = session.get("pending_operation_applied", False)
    operation = session.get("pending_operation")

    if answer is not None:
        if applied:
            return "finalize_applied_answer_before_new_questions"
        if operation:
            return "apply_pending_answer_before_new_questions"
        return "interpret_pending_answer_before_new_questions"
    if not session.get("setup_confirmed", False):
        return "confirm_scope_and_setup_before_graph_mutation"
    if session.get("presented_frontier"):
        return "resume_exact_presented_frontier"
    return "continue_session_phase"


def start_session(
    db: Any,
    *,
    raw_invocation: str,
    interpreted_request: str,
    focus: list[str],
    depth: str,
    stance: str,
) -> dict[str, Any]:
    existing = get_session(db)
    if existing and existing.get("status") in {"active", "paused"}:
        raise ValueError("An unfinished Map session already exists; resume or abandon it before starting another")
    if existing:
        db.delete(SESSION_ID)

    for focus_id in focus:
        node = map_state.get_node(db, focus_id)
        if not node:
            raise ValueError(f"No focus node {focus_id!r}")

    db.create(SESSION_ID, {
        "status": "active",
        "phase": "setup",
        "focus_nodes": node_ids(focus),
        "raw_invocation": raw_invocation,
        "interpreted_request": interpreted_request,
        "depth": depth,
        "stance": stance,
        "setup_confirmed": False,
        "presented_frontier": [],
        "pending_user_answer": None,
        "pending_operation": None,
        "pending_operation_applied": False,
    })
    session = require_session(db)
    return session_summary(db, session)


def confirm_session(db: Any) -> dict[str, Any]:
    session = require_session(db)
    if session.get("status") not in {"active", "paused"}:
        raise ValueError(f"Cannot confirm session in status {session.get('status')!r}")
    if session.get("pending_user_answer") is not None:
        raise ValueError("Cannot confirm setup while a user answer is pending recovery")
    db.query(
        "UPDATE $session MERGE { setup_confirmed: true, status: 'active', phase: 'confirmed', updated_at: time::now() };",
        {"session": SESSION_ID},
    )
    return session_summary(db, require_session(db))


def eligible_frontier_ids(db: Any, session: dict[str, Any]) -> set[str]:
    focus_records = session.get("focus_nodes", []) or []
    if not focus_records:
        return {map_state.node_key(item["id"]) for item in map_state.compute_frontier(db)["frontier"]}

    eligible: set[str] = set()
    for focus in focus_records:
        result = map_state.compute_frontier(db, str(focus))
        eligible.update(map_state.node_key(item["id"]) for item in result["frontier"])
    return eligible


def checkpoint_session(db: Any, *, phase: str, frontier: list[str]) -> dict[str, Any]:
    session = require_session(db)
    if not session.get("setup_confirmed", False):
        raise ValueError("Setup must be confirmed before presenting a substantive frontier")
    if session.get("pending_user_answer") is not None:
        raise ValueError("A pending user answer must be recovered before presenting a new frontier")

    eligible = eligible_frontier_ids(db, session)
    requested: list[RecordID] = []
    for node_id in frontier:
        node = map_state.get_node(db, node_id)
        if not node:
            raise ValueError(f"No frontier node {node_id!r}")
        key = map_state.node_key(node["id"])
        if key not in eligible:
            raise ValueError(f"{node_id!r} is not currently frontier-eligible for this session focus")
        requested.append(map_state.rid(node_id))

    db.query(
        "UPDATE $session MERGE { status: 'active', phase: $phase, presented_frontier: $frontier, updated_at: time::now() };",
        {"session": SESSION_ID, "phase": phase, "frontier": requested},
    )
    return session_summary(db, require_session(db))


def persist_answer(db: Any, *, raw_answer: str, operation: str | None) -> dict[str, Any]:
    session = require_session(db)
    if not session.get("setup_confirmed", False):
        raise ValueError("Cannot persist a substantive answer before setup confirmation")
    if session.get("pending_user_answer") is not None:
        raise ValueError("A user answer is already pending; recover it before accepting another")
    if not session.get("presented_frontier"):
        raise ValueError("No presented frontier is awaiting an answer")

    db.query(
        "UPDATE $session MERGE { phase: 'answer_received', pending_user_answer: $answer, pending_operation: $operation, pending_operation_applied: false, updated_at: time::now() };",
        {"session": SESSION_ID, "answer": raw_answer, "operation": operation},
    )
    return session_summary(db, require_session(db))


def mark_applied(db: Any) -> dict[str, Any]:
    session = require_session(db)
    if session.get("pending_user_answer") is None:
        raise ValueError("No pending user answer exists")
    db.query(
        "UPDATE $session MERGE { phase: 'answer_applied', pending_operation_applied: true, updated_at: time::now() };",
        {"session": SESSION_ID},
    )
    return session_summary(db, require_session(db))


def advance_session(db: Any, *, phase: str, no_mutation: bool) -> dict[str, Any]:
    session = require_session(db)
    if session.get("pending_user_answer") is None:
        raise ValueError("No pending user answer exists to finalize")
    if not session.get("pending_operation_applied", False) and not no_mutation:
        raise ValueError("Pending answer has not been marked applied; use 'session applied' after graph mutation or --no-mutation")

    db.query(
        "UPDATE $session MERGE { phase: $phase, presented_frontier: [], pending_user_answer: NONE, pending_operation: NONE, pending_operation_applied: false, updated_at: time::now() };",
        {"session": SESSION_ID, "phase": phase},
    )
    return session_summary(db, require_session(db))


def resume_session(db: Any) -> dict[str, Any]:
    session = require_session(db)
    if session.get("status") == "abandoned":
        raise ValueError("Current session was abandoned; start a new session")
    if session.get("status") == "paused":
        db.query(
            "UPDATE $session MERGE { status: 'active', updated_at: time::now() };",
            {"session": SESSION_ID},
        )
        session = require_session(db)
    return {"resume_action": resume_action(session), "session": session_summary(db, session)}


def set_status(db: Any, status: str) -> dict[str, Any]:
    session = require_session(db)
    db.query(
        "UPDATE $session MERGE { status: $status, updated_at: time::now() };",
        {"session": SESSION_ID, "status": status},
    )
    return session_summary(db, require_session(db))


def finish_session(db: Any) -> dict[str, Any]:
    session = require_session(db)
    if session.get("pending_user_answer") is not None:
        raise ValueError("Cannot finish while a user answer is pending recovery")
    snapshot = session_summary(db, session)
    db.delete(SESSION_ID)
    return {"finished": True, "session": snapshot}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="map-state session", description="Durable /map workflow session state")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="Directory whose .map/ state should be used")
    sub = parser.add_subparsers(dest="session_command", required=True)

    start = sub.add_parser("start", help="Create a non-authoritative setup checkpoint")
    start.add_argument("--invocation", required=True)
    start.add_argument("--interpreted", required=True)
    start.add_argument("--focus", action="append", default=[])
    start.add_argument("--depth", choices=["mvp", "thorough"], default="mvp")
    start.add_argument("--stance", choices=["normal", "adversarial"], default="normal")

    sub.add_parser("status", help="Show the current session checkpoint")
    sub.add_parser("confirm", help="Confirm interpreted scope/setup before semantic graph mutation")

    checkpoint = sub.add_parser("checkpoint", help="Persist the exact frontier before presenting questions")
    checkpoint.add_argument("--phase", default="questioning")
    checkpoint.add_argument("frontier", nargs="*")

    answer = sub.add_parser("answer", help="Persist the raw user answer before graph mutation")
    answer.add_argument("answer")
    answer.add_argument("--operation", help="Optional intended graph operation description")

    sub.add_parser("applied", help="Mark the pending answer's graph operation as successfully applied")

    advance = sub.add_parser("advance", help="Clear a recovered/applied answer and continue")
    advance.add_argument("--phase", default="discovery")
    advance.add_argument("--no-mutation", action="store_true", help="Explicitly confirm that this answer required no graph mutation")

    sub.add_parser("resume", help="Return the highest-priority exact recovery action")
    sub.add_parser("pause", help="Pause without discarding workflow continuity")
    sub.add_parser("abandon", help="Explicitly abandon the current session")
    sub.add_parser("finish", help="Delete stable session state after successful completion")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root: Path = args.root

    try:
        def run(db: Any):
            command = args.session_command
            if command == "start":
                map_state.emit(start_session(
                    db,
                    raw_invocation=args.invocation,
                    interpreted_request=args.interpreted,
                    focus=args.focus,
                    depth=args.depth,
                    stance=args.stance,
                ))
            elif command == "status":
                session = get_session(db)
                map_state.emit({"exists": bool(session), "session": session_summary(db, session) if session else None})
            elif command == "confirm":
                map_state.emit(confirm_session(db))
            elif command == "checkpoint":
                map_state.emit(checkpoint_session(db, phase=args.phase, frontier=args.frontier))
            elif command == "answer":
                map_state.emit(persist_answer(db, raw_answer=args.answer, operation=args.operation))
            elif command == "applied":
                map_state.emit(mark_applied(db))
            elif command == "advance":
                map_state.emit(advance_session(db, phase=args.phase, no_mutation=args.no_mutation))
            elif command == "resume":
                map_state.emit(resume_session(db))
            elif command == "pause":
                map_state.emit(set_status(db, "paused"))
            elif command == "abandon":
                map_state.emit(set_status(db, "abandoned"))
            elif command == "finish":
                map_state.emit(finish_session(db))
            else:
                raise AssertionError(command)

        map_state.command_with_db(root, run)
        return 0
    except Exception as exc:
        print(f"map-state: {exc}", file=sys.stderr)
        return 1

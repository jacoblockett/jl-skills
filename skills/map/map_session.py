"""Durable conversational recovery state for Map.

Session state is deliberately separate from authoritative graph state. It stores only
the compact recovery summary, a rolling verbatim exchange, and potentially unpersisted
pending conversational work.
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
DEFAULT_EXCHANGE_DEPTH = 6
MIN_EXCHANGE_DEPTH = 2
MAX_SUMMARY_CHARS = 2200


def _session_rows(db: Any) -> list[dict[str, Any]]:
    value = db.select("map_session")
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def get_session(db: Any) -> dict[str, Any] | None:
    rows = _session_rows(db)
    if len(rows) > 1:
        raise RuntimeError(f"Multiple Map sessions exist ({len(rows)}); end the session before continuing")
    return rows[0] if rows else None


def require_session(db: Any) -> dict[str, Any]:
    session = get_session(db)
    if not session:
        raise ValueError("No current Map session")
    return session


def normalize_summary(text: str) -> str:
    return " ".join(text.split())


def summary_payload(session: dict[str, Any]) -> dict[str, Any]:
    summary = session.get("summary") or ""
    return {
        "summary": summary,
        "characters": len(summary),
        "limit": MAX_SUMMARY_CHARS,
    }


def exchange_payload(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "depth": int(session.get("exchange_depth") or DEFAULT_EXCHANGE_DEPTH),
        "exchange": list(session.get("exchange") or []),
    }


def pending_payload(session: dict[str, Any]) -> dict[str, Any]:
    return {"pending": session.get("pending")}


def init_session(db: Any) -> dict[str, Any]:
    if get_session(db):
        raise ValueError("A Map session already exists; end it before initializing another")
    db.create(SESSION_ID, {
        "summary": "",
        "exchange_depth": DEFAULT_EXCHANGE_DEPTH,
        "exchange": [],
        "pending": None,
    })
    session = require_session(db)
    return {
        "ok": True,
        "session": str(session["id"]),
        **summary_payload(session),
        **exchange_payload(session),
        **pending_payload(session),
    }


def set_summary(db: Any, text: str) -> dict[str, Any]:
    require_session(db)
    normalized = normalize_summary(text)
    if len(normalized) > MAX_SUMMARY_CHARS:
        raise ValueError(
            f"Summary exceeds {MAX_SUMMARY_CHARS}-character limit "
            f"({len(normalized)}/{MAX_SUMMARY_CHARS}); consolidate and retry"
        )
    db.query(
        "UPDATE $session_id MERGE { summary: $summary, updated_at: time::now() };",
        {"session_id": SESSION_ID, "summary": normalized},
    )
    return summary_payload(require_session(db))


def update_exchange(
    db: Any,
    *,
    depth: int | None = None,
    role: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    session = require_session(db)
    current_depth = int(session.get("exchange_depth") or DEFAULT_EXCHANGE_DEPTH)
    if depth is not None:
        if depth < MIN_EXCHANGE_DEPTH:
            raise ValueError(f"Exchange depth must be at least {MIN_EXCHANGE_DEPTH}")
        current_depth = depth

    exchange = list(session.get("exchange") or [])
    if role is not None:
        if message is None:
            raise ValueError("Exchange append requires a message")
        exchange.append({"role": role, "message": message})

    if len(exchange) > current_depth:
        exchange = exchange[-current_depth:]

    if depth is not None or role is not None:
        db.query(
            """UPDATE $session_id MERGE {
                exchange_depth: $depth,
                exchange: $exchange,
                updated_at: time::now()
            };""",
            {"session_id": SESSION_ID, "depth": current_depth, "exchange": exchange},
        )
        session = require_session(db)

    return exchange_payload(session)


def set_pending(db: Any, text: str) -> dict[str, Any]:
    require_session(db)
    if not text.strip():
        raise ValueError("Pending content must not be empty; use --clear to remove it")
    db.query(
        "UPDATE $session_id MERGE { pending: $pending, updated_at: time::now() };",
        {"session_id": SESSION_ID, "pending": text},
    )
    return pending_payload(require_session(db))


def clear_pending(db: Any) -> dict[str, Any]:
    require_session(db)
    db.query(
        "UPDATE $session_id MERGE { pending: NONE, updated_at: time::now() };",
        {"session_id": SESSION_ID},
    )
    return pending_payload(require_session(db))


def end_session(db: Any, *, force: bool) -> dict[str, Any]:
    session = require_session(db)
    pending = session.get("pending")
    if pending is not None and not force:
        raise ValueError("Cannot end Map session while pending work exists; clear it or use --force")
    discarded_pending = pending is not None
    db.query("DELETE map_session;")
    if get_session(db) is not None:
        raise RuntimeError("Map session deletion did not complete")
    return {
        "ended": True,
        "forced": force,
        "discarded_pending": discarded_pending,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="map session",
        description="Durable conversational recovery state for Map",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="Directory whose .map/ state should be used",
    )
    sub = parser.add_subparsers(dest="session_command", required=True)

    sub.add_parser("init", help="Initialize a new recovery session")

    summary = sub.add_parser("summary", help="Read or replace the compact recovery summary")
    summary.add_argument("new_summary", nargs="?")

    exchange = sub.add_parser("exchange", help="Read or update the rolling verbatim exchange")
    roles = exchange.add_mutually_exclusive_group()
    roles.add_argument("-u", "--user", metavar="MESSAGE", help="Append an exact user message")
    roles.add_argument("-a", "--assistant", metavar="MESSAGE", help="Append an exact assistant message")
    exchange.add_argument(
        "--depth",
        type=int,
        metavar="N",
        help=f"Set retained message count (default {DEFAULT_EXCHANGE_DEPTH}, minimum {MIN_EXCHANGE_DEPTH})",
    )

    pending = sub.add_parser("pending", help="Read, replace, or clear potentially unpersisted work")
    pending.add_argument("new_pending", nargs="?")
    pending.add_argument("--clear", action="store_true", help="Clear pending work after Map persistence is verified")

    end = sub.add_parser("end", help="Delete the current recovery session")
    end.add_argument("--force", action="store_true", help="Delete even when pending work exists")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root: Path = args.root
    try:
        def run(db: Any):
            command = args.session_command
            if command == "init":
                map_state.emit(init_session(db))
            elif command == "summary":
                if args.new_summary is None:
                    map_state.emit(summary_payload(require_session(db)))
                else:
                    map_state.emit(set_summary(db, args.new_summary))
            elif command == "exchange":
                role = None
                message = None
                if args.user is not None:
                    role, message = "user", args.user
                elif args.assistant is not None:
                    role, message = "assistant", args.assistant
                map_state.emit(update_exchange(
                    db,
                    depth=args.depth,
                    role=role,
                    message=message,
                ))
            elif command == "pending":
                if args.clear and args.new_pending is not None:
                    raise ValueError("pending text and --clear are mutually exclusive")
                if args.clear:
                    map_state.emit(clear_pending(db))
                elif args.new_pending is not None:
                    map_state.emit(set_pending(db, args.new_pending))
                else:
                    map_state.emit(pending_payload(require_session(db)))
            elif command == "end":
                map_state.emit(end_session(db, force=args.force))
            else:
                raise AssertionError(command)

        map_state.command_with_db(root, run)
        return 0
    except Exception as exc:
        print(f"map: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

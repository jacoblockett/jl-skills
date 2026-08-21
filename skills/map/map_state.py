"""Small state-engine prototype for the /map skill.

This is intentionally not the /map conversational skill. It is the deterministic
primitive that the future skill and ordinary agents will query.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    from surrealdb import RecordID, Surreal
except ImportError as exc:  # pragma: no cover - useful message before dependency install
    raise SystemExit(
        "Missing dependency: surrealdb. Install this prototype with `pip install -e .` "
        "from skills/map/."
    ) from exc


NAMESPACE = "map"
DATABASE = "state"
RELATIONS = {
    "contains",
    "depends_on",
    "constrains",
    "supports",
    "supersedes",
    "related_to",
}

DECISION_READY_STATES = {"settled", "satisfied"}


def db_dir(root: Path) -> Path:
    return root.resolve() / ".map" / "db"


def db_url(root: Path) -> str:
    # Surreal's embedded URL accepts an absolute filesystem path. as_posix() also
    # avoids backslash escaping problems when this is run from Windows.
    return f"surrealkv://{db_dir(root).as_posix()}"


def schema_text() -> str:
    return (Path(__file__).resolve().parent / "schema.surql").read_text(encoding="utf-8")


def rid(node_id: str) -> RecordID:
    if node_id.startswith("node:"):
        node_id = node_id.split(":", 1)[1]
    return RecordID("node", node_id)


def printable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): printable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [printable(v) for v in value]
    # RecordID and SDK-specific values stringify cleanly and are not JSON-native.
    if value.__class__.__module__.startswith("surrealdb"):
        return str(value)
    return value


def emit(value: Any) -> None:
    print(json.dumps(printable(value), indent=2, ensure_ascii=False, default=str))


def check_raw_response(raw: Any) -> None:
    """Raise on SurrealQL errors while tolerating SDK response-shape changes."""
    statements = raw.get("result", []) if isinstance(raw, dict) else raw
    if not isinstance(statements, (list, tuple)):
        return
    failures = []
    for statement in statements:
        if isinstance(statement, dict) and statement.get("status") not in (None, "OK"):
            failures.append(statement)
    if failures:
        raise RuntimeError(f"SurrealQL failed: {failures}")


def open_db(root: Path):
    (root.resolve() / ".map").mkdir(parents=True, exist_ok=True)
    connection = Surreal(db_url(root))
    connection.connect()
    connection.use(NAMESPACE, DATABASE)
    return connection


def apply_schema(db: Any) -> None:
    raw = db.query_raw(schema_text())
    check_raw_response(raw)


def init_map(root: Path) -> None:
    db = open_db(root)
    try:
        apply_schema(db)
        emit({"ok": True, "database": str(db_dir(root)), "namespace": NAMESPACE, "db": DATABASE})
    finally:
        db.close()


def create_node(db: Any, node_id: str, data: dict[str, Any]) -> Any:
    payload = {
        "kind": data["kind"],
        "state": data["state"],
        "authority": data["authority"],
        "subject": data["subject"],
        "detail": data.get("detail"),
        "value": data.get("value"),
        "source_note": data.get("source_note"),
        "tags": data.get("tags", []),
    }
    return db.create(rid(node_id), payload)


def relate(
    db: Any,
    source: str,
    relation: str,
    target: str,
    *,
    note: str | None = None,
    condition: dict[str, Any] | None = None,
) -> Any:
    if relation not in RELATIONS:
        raise ValueError(f"Unknown relation {relation!r}; allowed: {sorted(RELATIONS)}")
    data: dict[str, Any] = {"note": note}
    if relation == "depends_on":
        data["condition"] = condition
    query = f"RELATE $source->{relation}->$target CONTENT $data;"
    return db.query(query, {"source": rid(source), "target": rid(target), "data": data})


def all_nodes(db: Any) -> list[dict[str, Any]]:
    return list(db.select("node") or [])


def get_node(db: Any, node_id: str) -> dict[str, Any] | None:
    value = db.select(rid(node_id))
    if isinstance(value, list):
        return value[0] if value else None
    return value


def node_key(value: Any) -> str:
    return str(value)


def parse_scalar(text: str) -> Any:
    """Accept convenient JSON scalars/objects while keeping ordinary text as text."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def condition_matches(prerequisite: dict[str, Any], condition: dict[str, Any] | None) -> bool:
    if not condition:
        return True

    # Prototype condition vocabulary. Deliberately non-executable and tiny.
    # {"field": "value", "op": "eq", "value": "separate"}
    field = condition.get("field", "value")
    op = condition.get("op", "eq")
    expected = condition.get("value")
    actual = prerequisite.get(field)

    if op == "eq":
        return actual == expected
    if op == "neq":
        return actual != expected
    if op == "in":
        return actual in (expected or [])
    raise ValueError(f"Unsupported dependency condition op: {op!r}")


def contained_scope(db: Any, focus_id: str) -> set[str]:
    """Return the focus node plus everything recursively contained beneath it.

    This is the first locality primitive. Candidate decisions are scoped by containment,
    while their prerequisites may still live outside the scope and are evaluated normally.
    """
    focus = get_node(db, focus_id)
    if not focus:
        raise ValueError(f"No focus node {focus_id!r}")

    edges = list(db.select("contains") or [])
    children: dict[str, list[str]] = {}
    for edge in edges:
        children.setdefault(node_key(edge["in"]), []).append(node_key(edge["out"]))

    seen = {node_key(focus["id"])}
    queue = [node_key(focus["id"])]
    while queue:
        current = queue.pop(0)
        for child in children.get(current, []):
            if child not in seen:
                seen.add(child)
                queue.append(child)
    return seen


def compute_frontier(db: Any, focus_id: str | None = None) -> dict[str, Any]:
    nodes = all_nodes(db)
    by_id = {node_key(node["id"]): node for node in nodes}
    dependencies = list(db.select("depends_on") or [])
    scope_ids = contained_scope(db, focus_id) if focus_id is not None else None

    outgoing: dict[str, list[dict[str, Any]]] = {}
    for edge in dependencies:
        outgoing.setdefault(node_key(edge["in"]), []).append(edge)

    ready: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    inapplicable: list[dict[str, Any]] = []

    for node in nodes:
        if node.get("kind") != "decision" or node.get("state") != "open":
            continue
        if scope_ids is not None and node_key(node["id"]) not in scope_ids:
            continue

        reasons: list[str] = []
        applicable = True
        for edge in outgoing.get(node_key(node["id"]), []):
            prerequisite = by_id.get(node_key(edge["out"]))
            if not prerequisite:
                reasons.append(f"missing prerequisite {edge['out']}")
                continue

            if prerequisite.get("state") not in DECISION_READY_STATES:
                reasons.append(f"waiting for {prerequisite['id']}")
                continue

            if not condition_matches(prerequisite, edge.get("condition")):
                applicable = False
                reasons.append(f"condition false for {prerequisite['id']}")

        summary = {
            "id": node["id"],
            "subject": node.get("subject"),
            "reasons": reasons,
        }
        if not applicable:
            inapplicable.append(summary)
        elif reasons:
            blocked.append(summary)
        else:
            ready.append(summary)

    result = {"frontier": ready, "blocked": blocked, "inapplicable": inapplicable}
    if focus_id is not None:
        result = {"focus": get_node(db, focus_id)["id"], **result}
    return result


def settle_decision(db: Any, node_id: str, value: Any) -> Any:
    node = get_node(db, node_id)
    if not node:
        raise ValueError(f"No node {node_id!r}")
    if node.get("kind") != "decision":
        raise ValueError(f"{node_id!r} is {node.get('kind')!r}, not a decision")
    return db.query(
        "UPDATE $node MERGE { state: 'settled', value: $value, updated_at: time::now() };",
        {"node": rid(node_id), "value": value},
    )


def promote_idea(db: Any, node_id: str, parent_id: str | None = None) -> dict[str, Any]:
    """Promote a parked future-goal idea into active user intent.

    This deliberately implements only idea -> intent for the first evolution fixture.
    Other promotion targets should be added only when a real use case requires them.
    """
    node = get_node(db, node_id)
    if not node:
        raise ValueError(f"No node {node_id!r}")
    if node.get("kind") != "idea" or node.get("state") != "parked":
        raise ValueError(f"{node_id!r} must be a parked idea before it can be promoted")

    if parent_id is not None:
        parent = get_node(db, parent_id)
        if not parent:
            raise ValueError(f"No parent node {parent_id!r}")
        if parent.get("kind") != "intent":
            raise ValueError(f"Parent {parent_id!r} is {parent.get('kind')!r}, not an intent")

    db.query(
        "UPDATE $node MERGE { kind: 'intent', state: 'active', authority: 'user', updated_at: time::now() };",
        {"node": rid(node_id)},
    )
    if parent_id is not None:
        relate(db, parent_id, "contains", node_id)

    promoted = get_node(db, node_id)
    if promoted is None:  # pragma: no cover - defensive SDK/storage invariant
        raise RuntimeError(f"Promoted node {node_id!r} disappeared")
    return promoted


def wipe(db: Any) -> None:
    # db.query() executes immediately in the current Python SDK and returns results.
    # Relation rows are deleted first to keep ENFORCED graph tables unsurprising.
    for table in sorted(RELATIONS):
        db.query(f"DELETE {table};")
    db.query("DELETE map_session;")
    db.query("DELETE node;")


def seed_chores(db: Any) -> None:
    """Seed the first real regression fixture at its initial unresolved frontier."""
    wipe(db)

    create_node(db, "chores", {
        "kind": "intent", "state": "active", "authority": "user",
        "subject": "Recurring household chore tracker",
        "detail": "Tiny browser-only app for adding recurring chores, seeing what needs doing, and marking chores complete.",
    })

    constraints = [
        ("browser-only", "Run entirely in the browser"),
        ("no-accounts", "No user accounts"),
        ("no-server", "No server"),
        ("no-cloud-sync", "No cloud synchronization"),
        ("keep-small", "Keep the product intentionally small"),
    ]
    for node_id, subject in constraints:
        create_node(db, node_id, {
            "kind": "constraint", "state": "settled", "authority": "user", "subject": subject,
        })
        relate(db, node_id, "constrains", "chores")

    decisions = [
        ("recurrence", "Which recurrence patterns are supported?"),
        ("late-anchor", "Does late completion shift future due dates?"),
        ("missed-occurrences", "Do missed occurrences accumulate separately or collapse into one overdue chore?"),
        ("clear-backlog", "If missed occurrences accumulate, does completion clear one occurrence or all?"),
        ("first-due", "How is the first due date established?"),
        ("local-persistence", "Does chore and schedule state persist across browser restarts?"),
        ("monthly-missing-date", "What happens when a monthly anchor day does not exist in a month?"),
    ]
    for node_id, subject in decisions:
        create_node(db, node_id, {
            "kind": "decision", "state": "open", "authority": "user", "subject": subject,
        })
        relate(db, "chores", "contains", node_id)

    relate(
        db,
        "clear-backlog",
        "depends_on",
        "missed-occurrences",
        note="Only meaningful when missed occurrences accumulate separately.",
        condition={"field": "value", "op": "eq", "value": "separate"},
    )

    create_node(db, "shared-household", {
        "kind": "idea", "state": "parked", "authority": "none",
        "subject": "Shared household chores",
        "detail": "Multi-user/shared-household chore capability.",
    })
    relate(db, "shared-household", "related_to", "chores")


def command_with_db(root: Path, fn):
    db = open_db(root)
    try:
        apply_schema(db)
        return fn(db)
    finally:
        db.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="map-state", description="Prototype /map intent-graph state CLI")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="Directory whose .map/ state should be used")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Initialize .map/db and apply the schema")
    sub.add_parser("status", help="Show node/relation counts")
    sub.add_parser("list", help="List all graph nodes")
    frontier = sub.add_parser("frontier", help="Show open, blocked, and conditionally inapplicable decisions")
    frontier.add_argument("--focus", help="Limit candidate decisions to this node and its contained descendants")
    sub.add_parser("ideas", help="List parked ideas")
    sub.add_parser("seed-chores", help="Reset state and seed the recurring-chore regression fixture")

    show = sub.add_parser("show", help="Show one node")
    show.add_argument("id")

    settle = sub.add_parser("settle", help="Settle a decision with a value")
    settle.add_argument("id")
    settle.add_argument("value", help="JSON scalar/object/array, or plain text")

    promote = sub.add_parser("promote", help="Promote a parked idea into active user intent")
    promote.add_argument("id")
    promote.add_argument("--parent", help="Existing intent that should contain the promoted intent")

    add = sub.add_parser("add-node", help="Create a graph node")
    add.add_argument("id")
    add.add_argument("kind", choices=["intent", "decision", "constraint", "criterion", "idea", "fact"])
    add.add_argument("state")
    add.add_argument("authority", choices=["user", "inferred", "external", "derived", "none"])
    add.add_argument("subject")
    add.add_argument("--detail")
    add.add_argument("--value")

    edge = sub.add_parser("relate", help="Create a semantic graph relation")
    edge.add_argument("source")
    edge.add_argument("relation", choices=sorted(RELATIONS))
    edge.add_argument("target")
    edge.add_argument("--note")
    edge.add_argument("--condition", help="JSON condition object; only valid for depends_on")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root: Path = args.root

    try:
        if args.command == "init":
            init_map(root)
            return 0

        def run(db: Any):
            if args.command == "status":
                counts = {"nodes": len(all_nodes(db))}
                for relation in sorted(RELATIONS):
                    counts[relation] = len(db.select(relation) or [])
                counts["sessions"] = len(db.select("map_session") or [])
                emit(counts)
            elif args.command == "list":
                emit(all_nodes(db))
            elif args.command == "show":
                emit(get_node(db, args.id))
            elif args.command == "frontier":
                emit(compute_frontier(db, args.focus))
            elif args.command == "ideas":
                emit([n for n in all_nodes(db) if n.get("kind") == "idea" and n.get("state") == "parked"])
            elif args.command == "seed-chores":
                seed_chores(db)
                emit({"ok": True, "fixture": "chores", **compute_frontier(db)})
            elif args.command == "settle":
                value = parse_scalar(args.value)
                settle_decision(db, args.id, value)
                emit({"ok": True, "settled": args.id, "value": value, **compute_frontier(db)})
            elif args.command == "promote":
                promoted = promote_idea(db, args.id, args.parent)
                emit({"ok": True, "promoted": args.id, "node": promoted, **compute_frontier(db)})
            elif args.command == "add-node":
                value = parse_scalar(args.value) if args.value is not None else None
                result = create_node(db, args.id, {
                    "kind": args.kind,
                    "state": args.state,
                    "authority": args.authority,
                    "subject": args.subject,
                    "detail": args.detail,
                    "value": value,
                })
                emit(result)
            elif args.command == "relate":
                condition = json.loads(args.condition) if args.condition else None
                if condition is not None and args.relation != "depends_on":
                    raise ValueError("--condition is only supported for depends_on")
                emit(relate(db, args.source, args.relation, args.target, note=args.note, condition=condition))
            else:  # pragma: no cover
                raise AssertionError(args.command)

        command_with_db(root, run)
        return 0
    except Exception as exc:
        print(f"map-state: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

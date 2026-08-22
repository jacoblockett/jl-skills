"""Higher-level read-only queries for ordinary agents consulting Map."""

from __future__ import annotations

import re
from typing import Any

import map_query
import map_state


_WORD_RE = re.compile(r"\w+", re.UNICODE)


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return " ".join(_text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(f"{_text(key)} {_text(item)}" for key, item in value.items())
    return str(value)


def _tokens(text: str) -> list[str]:
    return [token.casefold() for token in _WORD_RE.findall(text)]


def _score_node(node: dict[str, Any], query: str, terms: list[str]) -> int:
    query_cf = query.casefold().strip()
    subject = _text(node.get("subject")).casefold()
    detail = _text(node.get("detail")).casefold()
    value = _text(node.get("value")).casefold()
    source_note = _text(node.get("source_note")).casefold()
    tags = _text(node.get("tags")).casefold()
    node_id = map_state.node_key(node["id"]).casefold()

    score = 0
    if query_cf:
        if query_cf == subject:
            score += 20
        elif query_cf in subject:
            score += 10
        if query_cf in detail:
            score += 5
        if query_cf in value:
            score += 5
        if query_cf in node_id:
            score += 4

    for term in terms:
        if term in subject:
            score += 4
        if term in detail:
            score += 2
        if term in value:
            score += 2
        if term in tags:
            score += 2
        if term in source_note:
            score += 1
        if term in node_id:
            score += 1
    return score


def search_nodes(db: Any, query: str, *, limit: int = 10, include_history: bool = False) -> dict[str, Any]:
    query = query.strip()
    if not query:
        raise ValueError("Search query must not be empty")
    if limit < 1:
        raise ValueError("--limit must be at least 1")

    nodes = map_state.all_nodes(db)
    replacements = map_state.supersession_map(db)
    terms = _tokens(query)
    ranked: list[tuple[int, dict[str, Any]]] = []

    for node in nodes:
        key = map_state.node_key(node["id"])
        if not include_history:
            if node.get("state") == "superseded":
                continue
            if map_state.resolve_current_id(key, replacements) != key:
                continue
        score = _score_node(node, query, terms)
        if score:
            ranked.append((score, node))

    ranked.sort(key=lambda item: (-item[0], map_state.node_key(item[1]["id"])))
    results = []
    for score, node in ranked[:limit]:
        item = map_query.summary(node)
        item["score"] = score
        results.append(item)

    return {
        "query": query,
        "include_history": include_history,
        "results": results,
    }


def _current_node(db: Any, node: dict[str, Any]) -> dict[str, Any]:
    replacements = map_state.supersession_map(db)
    current_id = map_state.resolve_current_id(map_state.node_key(node["id"]), replacements)
    current = map_state.get_node(db, current_id)
    if not current:
        raise RuntimeError(f"Current node {current_id} does not exist")
    return current


def explain_node(db: Any, node_id: str) -> dict[str, Any]:
    """Return graph-supported context explaining one current semantic node."""
    requested = map_state.get_node(db, node_id)
    if not requested:
        raise ValueError(f"No node {node_id!r}")

    current = _current_node(db, requested)
    current_key = map_state.node_key(current["id"])
    replacements = map_state.supersession_map(db)
    by_id = {map_state.node_key(node["id"]): node for node in map_state.all_nodes(db)}

    lineage = map_query.history_for(db, map_state.node_key(requested["id"]))
    ancestor_ids = map_query.ancestors(db, current_key)
    ancestor_nodes = [map_query.summary(by_id[item]) for item in sorted(ancestor_ids) if item in by_id]
    relevant_targets = ancestor_ids | {current_key}

    constraints: dict[str, dict[str, Any]] = {}
    for edge in map_query.rows(db, "constrains"):
        if map_state.node_key(edge["out"]) not in relevant_targets:
            continue
        source_id = map_state.resolve_current_id(map_state.node_key(edge["in"]), replacements)
        source = by_id.get(source_id)
        if source and source.get("state") != "superseded":
            constraints[source_id] = source

    prerequisites: list[dict[str, Any]] = []
    dependents: list[dict[str, Any]] = []
    for edge in map_query.rows(db, "depends_on"):
        decision_id = map_state.node_key(edge["in"])
        historical_prerequisite = map_state.node_key(edge["out"])
        current_prerequisite = map_state.resolve_current_id(historical_prerequisite, replacements)

        if decision_id == current_key:
            prerequisite = by_id.get(current_prerequisite)
            item: dict[str, Any] = {
                "node": map_query.summary(prerequisite) if prerequisite else {"id": current_prerequisite, "missing": True},
            }
            if historical_prerequisite != current_prerequisite:
                item["historical_prerequisite"] = historical_prerequisite
            if edge.get("condition") is not None:
                item["condition"] = edge["condition"]
            if edge.get("note") is not None:
                item["note"] = edge["note"]
            prerequisites.append(item)

        if current_prerequisite == current_key:
            dependent_current_id = map_state.resolve_current_id(decision_id, replacements)
            dependent = by_id.get(dependent_current_id)
            item = {
                "node": map_query.summary(dependent) if dependent else {"id": dependent_current_id, "missing": True},
            }
            if historical_prerequisite != current_key:
                item["historical_prerequisite"] = historical_prerequisite
            if edge.get("condition") is not None:
                item["condition"] = edge["condition"]
            if edge.get("note") is not None:
                item["note"] = edge["note"]
            dependents.append(item)

    supports: list[dict[str, Any]] = []
    for edge in map_query.rows(db, "supports"):
        target_id = map_state.resolve_current_id(map_state.node_key(edge["out"]), replacements)
        if target_id not in relevant_targets:
            continue
        source_id = map_state.resolve_current_id(map_state.node_key(edge["in"]), replacements)
        source = by_id.get(source_id)
        if not source:
            continue
        item = {"node": map_query.summary(source), "supports": target_id}
        if edge.get("note") is not None:
            item["note"] = edge["note"]
        supports.append(item)

    direct = map_query.related_for(db, current_key)["relations"]

    key_fn = lambda item: map_state.node_key(item["node"]["id"])
    prerequisites.sort(key=key_fn)
    dependents.sort(key=key_fn)
    supports.sort(key=key_fn)

    return {
        "requested": requested["id"],
        "current": map_query.summary(current),
        "history": lineage,
        "ancestors": ancestor_nodes,
        "constraints": [map_query.summary(constraints[key]) for key in sorted(constraints)],
        "prerequisites": prerequisites,
        "dependents": dependents,
        "supports": supports,
        "direct_relations": direct,
    }

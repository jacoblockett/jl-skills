from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRATCH = REPO / "test"
VENV = SCRATCH / ".venv"
CHILD = "JL_MAP_STRESS_CHILD"


def vpy() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def vmap() -> Path:
    return VENV / ("Scripts/map.exe" if os.name == "nt" else "bin/map")


def bootstrap() -> None:
    if os.environ.get(CHILD) == "1":
        return
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    subprocess.run([sys.executable, "-c", "import sys; assert sys.version_info >= (3,11), sys.version"], check=True)
    subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    subprocess.run([str(vpy()), "-m", "pip", "install", "--disable-pip-version-check", "-e", str(REPO / "skills/map")], cwd=REPO, check=True)
    env = os.environ.copy()
    env[CHILD] = "1"
    raise SystemExit(subprocess.run([str(vpy()), str(Path(__file__).resolve())], cwd=REPO, env=env).returncode)


def run(root: str, *args: str, ok: bool = True) -> subprocess.CompletedProcess[str]:
    path = SCRATCH / root
    path.mkdir(parents=True, exist_ok=True)
    cp = subprocess.run(
        [str(vmap()), "--root", str(path), *args],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="strict",
    )
    if ok and cp.returncode:
        raise AssertionError(f"FAILED: {' '.join(args)}\nstdout:\n{cp.stdout}\nstderr:\n{cp.stderr}")
    if not ok and not cp.returncode:
        raise AssertionError(f"EXPECTED FAILURE: {' '.join(args)}\n{cp.stdout}")
    return cp


def j(root: str, *args: str):
    return json.loads(run(root, *args).stdout)


def fail(root: str, *args: str) -> None:
    run(root, *args, ok=False)


def add(root: str, kind: str, subject: str, node_id: str | None = None, *extra: str):
    args = ["add", kind, subject]
    if node_id:
        args += ["--id", node_id]
    args += list(extra)
    return j(root, *args)


def rel(root: str, source: str, relation: str, target: str, *extra: str):
    return j(root, "relate", source, relation, target, *extra)


def subjects(items: list[dict]) -> set[str]:
    return {x.get("subject") for x in items}


def valid(root: str) -> dict:
    d = j(root, "validate")
    assert d["ok"] is True and d["errors"] == [], d
    return d


def test_help() -> None:
    top = subprocess.run([str(vmap()), "--help"], stdout=subprocess.PIPE, text=True, encoding="utf-8", check=True).stdout
    ses = subprocess.run([str(vmap()), "session", "--help"], stdout=subprocess.PIPE, text=True, encoding="utf-8", check=True).stdout
    for cmd in "init status list show questions ideas decide revise promote add relate history context related validate search explain".split():
        assert cmd in top, cmd
    for cmd in "init summary exchange pending end".split():
        assert cmd in ses, cmd
    for removed in "start status confirm checkpoint answer apply-settle apply-settles applied advance resume pause abandon finish".split():
        assert removed not in ses, removed
    print("PASS: command surface")


def test_core() -> None:
    lazy = SCRATCH / "lazy"
    lazy.mkdir(parents=True, exist_ok=True)
    assert not (lazy / ".map").exists()
    assert j("lazy", "status")["nodes"] == 0
    assert (lazy / ".map/db").is_dir()

    j("core", "init")
    j("core", "init")
    assert valid("core")["nodes"] == 0
    u = add("core", "fact", "한글 UTF-8 출력 검사 ⟨ok⟩", "unicode-output", "--authority", "external", "--value", '{"verified":true}')
    assert u["subject"] == "한글 UTF-8 출력 검사 ⟨ok⟩", u

    specs = [
        ("intent", "Test application", "app", ()),
        ("constraint", "Application must remain local", "local-only", ()),
        ("criterion", "Core behavior must be testable", "acceptance", ()),
        ("idea", "Optional cloud synchronization", "cloud-sync", ()),
        ("fact", "Filesystem persistence is available", "fs-fact", ("--authority", "external", "--value", '{"verified":true}')),
        ("decision", "Where should data live?", "storage-mode", ("--authority", "inferred")),
        ("decision", "How should backups behave?", "backup-policy", ("--authority", "inferred")),
        ("decision", "Which UI mode should be used?", "ui-mode", ("--authority", "inferred")),
    ]
    for kind, subject, node_id, extra in specs:
        add("core", kind, subject, node_id, *extra)
    generated = add("core", "fact", "Generated identity fact", None, "--authority", "derived", "--value", "123")
    assert str(generated["id"]).startswith("node:"), generated

    for source, relation, target in [
        ("app", "contains", "storage-mode"), ("app", "contains", "backup-policy"),
        ("app", "contains", "ui-mode"), ("app", "contains", "acceptance"),
        ("local-only", "constrains", "app"), ("fs-fact", "supports", "storage-mode"),
        ("cloud-sync", "related_to", "app"),
    ]:
        rel("core", source, relation, target)
    rel("core", "backup-policy", "depends_on", "storage-mode", "--note", "Backups only matter for local storage.", "--condition", '{"field":"value","op":"eq","value":"local"}')

    expected = [
        ("app", "intent", "active", "user"), ("local-only", "constraint", "active", "user"),
        ("acceptance", "criterion", "active", "user"), ("cloud-sync", "idea", "parked", "none"),
        ("fs-fact", "fact", "active", "external"), ("storage-mode", "decision", "open", "inferred"),
    ]
    for node_id, kind, state, authority in expected:
        n = j("core", "show", node_id)
        assert (n["kind"], n["state"], n["authority"]) == (kind, state, authority), n

    q = j("core", "questions", "--focus", "app")
    assert {"Where should data live?", "Which UI mode should be used?"} <= subjects(q["frontier"]), q
    assert "How should backups behave?" in subjects(q["blocked"]), q
    j("core", "decide", "storage-mode", "local")
    assert "How should backups behave?" in subjects(j("core", "questions", "--focus", "app")["frontier"])
    j("core", "decide", "backup-policy", "daily")
    j("core", "decide", "ui-mode", "dark", "--authority", "user")

    j("core", "revise", "storage-mode", "cloud", "--new-id", "storage-mode-v2", "--subject", "Where should data live?")
    assert j("core", "show", "backup-policy")["state"] == "needs_review"
    assert "How should backups behave?" in subjects(j("core", "questions", "--focus", "app")["inapplicable"])
    j("core", "revise", "storage-mode-v2", "local", "--new-id", "storage-mode-v3")
    assert "How should backups behave?" in subjects(j("core", "questions", "--focus", "app")["frontier"])
    j("core", "decide", "backup-policy", "weekly")
    h = j("core", "history", "storage-mode")
    assert [x["state"] for x in h["revisions"]] == ["superseded", "superseded", "decided"], h

    for node_id, subject in [
        ("cond-parent-neq", "Conditional neq prerequisite"), ("cond-child-neq", "Conditional neq child"),
        ("cond-parent-in", "Conditional in prerequisite"), ("cond-child-in", "Conditional in child"),
    ]:
        add("core", "decision", subject, node_id, "--authority", "inferred")
        rel("core", "app", "contains", node_id)
    rel("core", "cond-child-neq", "depends_on", "cond-parent-neq", "--condition", '{"field":"value","op":"neq","value":"blocked"}')
    rel("core", "cond-child-in", "depends_on", "cond-parent-in", "--condition", '{"field":"value","op":"in","value":["a","b","c"]}')
    j("core", "decide", "cond-parent-neq", "allowed")
    j("core", "decide", "cond-parent-in", "b")
    q = j("core", "questions", "--focus", "app")
    assert {"Conditional neq child", "Conditional in child"} <= subjects(q["frontier"]), q
    j("core", "decide", "cond-child-neq", "yes")
    j("core", "decide", "cond-child-in", "yes")

    current = j("core", "search", "Where should data live?")["results"]
    history = j("core", "search", "Where should data live?", "--include-history", "--limit", "20")["results"]
    assert len(current) == 1, current
    assert len(history) >= 3, history
    assert j("core", "context", "app")["focus"]["subject"] == "Test application"
    assert "relations" in j("core", "related", "backup-policy")
    assert "history" in j("core", "explain", "backup-policy")
    assert len(j("core", "list")) == j("core", "status")["nodes"]

    assert "Optional cloud synchronization" in subjects(j("core", "ideas"))
    j("core", "promote", "cloud-sync", "--parent", "app")
    p = j("core", "show", "cloud-sync")
    assert "Optional cloud synchronization" not in subjects(j("core", "ideas"))
    assert (p["kind"], p["state"], p["authority"]) == ("intent", "active", "user"), p

    fail("core", "add", "decision", "Impossible decision state", "--id", "bad-decision-state", "--state", "satisfied")
    fail("core", "add", "idea", "Impossible active idea", "--id", "bad-idea-state", "--state", "active")
    fail("core", "add", "fact", "Duplicate ID", "--id", "app")
    fail("core", "decide", "app", "true")
    fail("core", "decide", "storage-mode-v3", "local")
    add("core", "decision", "Still unresolved", "unresolved", "--authority", "inferred")
    fail("core", "revise", "unresolved", "value")
    fail("core", "promote", "app")
    fail("core", "relate", "local-only", "constrains", "app", "--condition", '{"field":"value","op":"eq","value":true}')
    fail("core", "relate", "missing-node", "related_to", "app")
    fail("core", "search", "anything", "--limit", "0")
    fail("core", "seed-chores")
    valid("core")
    print("PASS: core graph/query/mutation surface")


def test_processes() -> None:
    j("ids", "init")
    for i in range(250):
        add("ids", "fact", f"Generated identity stress {i}", None, "--authority", "derived")
    assert j("ids", "status")["nodes"] == 250
    valid("ids")
    print("PASS: 250 generated IDs across 250 CLI processes")


def test_session_capsule() -> None:
    for command in [("summary",), ("exchange",), ("pending",), ("end",)]:
        fail("session", "session", *command)

    created = j("session", "session", "init")
    assert created["ok"] is True and created["depth"] == 6 and created["exchange"] == []
    assert created["summary"] == "" and created["pending"] is None
    assert j("session", "status")["sessions"] == 1
    fail("session", "session", "init")

    summary = j("session", "session", "summary", "  甲事已定。\n\n乙事未決。\t待 user 回答。  ")
    assert summary["summary"] == "甲事已定。 乙事未決。 待 user 回答。", summary
    assert summary["characters"] == len(summary["summary"])
    assert summary["limit"] == 2200
    fail("session", "session", "summary", "x" * 2201)
    assert j("session", "session", "summary")["summary"] == summary["summary"]

    messages = [
        ("-u", "user one\nexact"),
        ("-a", "assistant one  exact"),
        ("-u", "user two"),
        ("-a", "assistant two"),
        ("-u", "user three"),
        ("-a", "assistant three"),
        ("-u", "user four"),
    ]
    for flag, message in messages:
        j("session", "session", "exchange", flag, message)
    exchange = j("session", "session", "exchange")
    assert exchange["depth"] == 6 and len(exchange["exchange"]) == 6, exchange
    assert exchange["exchange"][0]["message"] == "assistant one  exact", exchange
    assert exchange["exchange"][-1] == {"role": "user", "message": "user four"}, exchange

    exchange = j("session", "session", "exchange", "--depth", "4")
    assert exchange["depth"] == 4 and len(exchange["exchange"]) == 4
    assert exchange["exchange"][0]["message"] == "assistant two"
    fail("session", "session", "exchange", "--depth", "1")
    fail("session", "session", "exchange", "-u", "one", "-a", "two")
    exchange = j("session", "session", "exchange", "--depth", "3", "-a", "new assistant")
    assert exchange["depth"] == 3 and len(exchange["exchange"]) == 3
    assert exchange["exchange"][-1] == {"role": "assistant", "message": "new assistant"}

    assert j("session", "session", "pending")["pending"] is None
    pending_text = "1. First exact question?\n2. Second exact question?"
    assert j("session", "session", "pending", pending_text)["pending"] == pending_text
    fail("session", "session", "pending", "   ")
    fail("session", "session", "pending", "replacement", "--clear")
    fail("session", "session", "end")
    assert j("session", "session", "pending", "--clear")["pending"] is None

    ended = j("session", "session", "end")
    assert ended == {"ended": True, "forced": False, "discarded_pending": False}, ended
    assert j("session", "status")["sessions"] == 0
    fail("session", "session", "summary")

    j("session", "session", "init")
    j("session", "session", "pending", "Potentially unpersisted work")
    forced = j("session", "session", "end", "--force")
    assert forced == {"ended": True, "forced": True, "discarded_pending": True}, forced
    assert j("session", "status")["sessions"] == 0
    print("PASS: recovery-capsule CRUD and limits")


def test_session_ordering_and_recovery() -> None:
    add("abc", "decision", "Enable the feature?", "abc-decision", "--authority", "inferred")
    j("abc", "session", "init")

    assistant = "Should the feature be enabled?"
    answer = "Yes, enable it."
    j("abc", "session", "exchange", "-a", assistant)
    j("abc", "session", "pending", assistant)

    # A: the user's exact response and completed-pair summary become durable first.
    j("abc", "session", "exchange", "-u", answer)
    j("abc", "session", "summary", "功能啟用待定；assistant 問是否啟用，user 明答 Yes, enable it.")
    assert j("abc", "session", "pending")["pending"] == assistant
    assert j("abc", "show", "abc-decision")["state"] == "open"

    # B: normal Map commands persist the semantic consequence.
    j("abc", "decide", "abc-decision", "true")
    decided = j("abc", "show", "abc-decision")
    assert decided["state"] == "decided" and decided["value"] is True, decided

    # A crash here is recoverable: pending intentionally remains until C.
    assert j("abc", "session", "pending")["pending"] == assistant
    recovery_exchange = j("abc", "session", "exchange")["exchange"]
    assert recovery_exchange[-2:] == [
        {"role": "assistant", "message": assistant},
        {"role": "user", "message": answer},
    ]

    # C: only verified persistence allows pending to clear.
    assert j("abc", "session", "pending", "--clear")["pending"] is None
    assert j("abc", "session", "end")["ended"] is True
    print("PASS: session-first A -> B -> C recovery ordering")


def test_validator() -> None:
    j("invalid", "init")
    add("invalid", "intent", "Cycle A", "cycle-a")
    add("invalid", "intent", "Cycle B", "cycle-b")
    rel("invalid", "cycle-a", "contains", "cycle-b")
    rel("invalid", "cycle-b", "contains", "cycle-a")
    add("invalid", "fact", "Not actually a decision", "bad-dependency-source")
    add("invalid", "decision", "Dependency target", "bad-dependency-target")
    rel("invalid", "bad-dependency-source", "depends_on", "bad-dependency-target")
    add("invalid", "decision", "Bad condition source", "bad-condition-source")
    add("invalid", "decision", "Bad condition target", "bad-condition-target")
    rel("invalid", "bad-condition-source", "depends_on", "bad-condition-target", "--condition", '{"field":"value","op":"nonsense","value":1}')
    rel("invalid", "cycle-a", "related_to", "cycle-b")
    rel("invalid", "cycle-a", "related_to", "cycle-b")
    d = j("invalid", "validate")
    assert d["ok"] is False, d
    errors, warnings = "\n".join(d["errors"]), "\n".join(d["warnings"])
    assert "contains relation contains a directed cycle" in errors
    assert "not a decision" in errors
    assert "unsupported op" in errors
    assert "duplicate related_to edge" in warnings
    print("PASS: validator rejects invalid graphs")


def main() -> None:
    bootstrap()
    assert vmap().exists(), vmap()
    test_help()
    test_core()
    test_processes()
    test_session_capsule()
    test_session_ordering_and_recovery()
    test_validator()
    print("\n======================================")
    print("ALL MAP RUNTIME STRESS TESTS PASSED")
    print("======================================")


if __name__ == "__main__":
    main()

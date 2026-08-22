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
    for cmd in "start status confirm checkpoint answer apply-settle apply-settles applied advance resume pause abandon finish".split():
        assert cmd in ses, cmd
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

    assert len(j("core", "search", "Where should data live?")["results"]) == 1
    assert len(j("core", "search", "Where should data live?", "--include-history", "--limit", "20")["results"]) >= 3
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


def test_session() -> None:
    j("session", "init")
    add("session", "intent", "Session lifecycle fixture", "s-root")
    for i in range(1, 7):
        add("session", "decision", f"Session decision {i}", f"s-d{i}", "--authority", "inferred")
        rel("session", "s-root", "contains", f"s-d{i}")
    add("session", "decision", "Blocked session decision", "s-blocked", "--authority", "inferred")
    rel("session", "s-root", "contains", "s-blocked")
    rel("session", "s-blocked", "depends_on", "s-d1")

    s = j("session", "session", "start", "--invocation", "/map session stress test", "--interpreted", "Exercise durable session behavior", "--focus", "s-root", "--depth", "thorough", "--stance", "adversarial")
    assert s["status"] == "active" and j("session", "session", "status")["exists"] is True
    fail("session", "session", "start", "--invocation", "second active session", "--interpreted", "should fail")
    fail("session", "session", "checkpoint", "s-d1")
    assert j("session", "session", "resume")["resume_action"] == "confirm_scope_and_setup_before_graph_mutation"
    assert j("session", "session", "pause")["status"] == "paused"
    assert j("session", "session", "status")["session"]["status"] == "paused"
    assert j("session", "session", "resume")["resume_action"] == "confirm_scope_and_setup_before_graph_mutation"
    assert j("session", "session", "confirm")["setup_confirmed"] is True
    fail("session", "session", "answer", "premature answer")
    fail("session", "session", "checkpoint", "s-blocked")

    j("session", "session", "checkpoint", "s-d1")
    assert j("session", "session", "resume")["resume_action"] == "resume_exact_presented_frontier"
    j("session", "session", "answer", "Use true for decision one", "--operation", "decide s-d1")
    assert j("session", "session", "resume")["resume_action"] == "apply_pending_answer_before_new_questions"
    fail("session", "session", "applied")
    assert j("session", "session", "apply-settle", "s-d1", "true")["atomic"] is True
    assert j("session", "session", "resume")["resume_action"] == "finalize_applied_answer_before_new_questions"
    j("session", "session", "advance")
    assert j("session", "session", "resume")["resume_action"] == "continue_session_phase"
    d1 = j("session", "show", "s-d1")
    assert d1["state"] == "decided" and d1["value"] is True and d1["authority"] == "user", d1

    j("session", "session", "checkpoint", "s-d2", "s-d3")
    j("session", "session", "answer", "Decision two is true and decision three is forty-two", "--operation", "decide s-d2 and s-d3")
    b = j("session", "session", "apply-settles", '{"s-d2":true,"s-d3":42}')
    assert b["atomic"] is True and b["count"] == 2, b
    j("session", "session", "advance")
    assert j("session", "show", "s-d2")["value"] is True
    d3 = j("session", "show", "s-d3")
    assert d3["value"] == 42 and not isinstance(d3["value"], str), d3

    j("session", "session", "checkpoint", "s-d4")
    j("session", "session", "answer", "No semantic change is required")
    assert j("session", "session", "resume")["resume_action"] == "interpret_pending_answer_before_new_questions"
    j("session", "session", "applied")
    assert j("session", "session", "resume")["resume_action"] == "finalize_applied_answer_before_new_questions"
    j("session", "session", "advance")
    assert j("session", "show", "s-d4")["state"] == "open"

    j("session", "session", "checkpoint", "s-d5")
    j("session", "session", "answer", "Still no graph mutation required")
    j("session", "session", "advance", "--phase", "discovery", "--no-mutation")
    assert j("session", "show", "s-d5")["state"] == "open"

    assert j("session", "session", "finish")["finished"] is True
    assert j("session", "session", "status")["exists"] is False
    j("session", "session", "start", "--invocation", "/map abandon test", "--interpreted", "test abandoned session", "--focus", "s-root")
    assert j("session", "session", "abandon")["status"] == "abandoned"
    fail("session", "session", "resume")
    j("session", "session", "start", "--invocation", "/map replacement session", "--interpreted", "replace abandoned session", "--focus", "s-root")
    j("session", "session", "confirm")
    j("session", "session", "finish")
    valid("session")
    print("PASS: complete session/recovery surface")


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
    test_session()
    test_validator()
    print("\n======================================")
    print("ALL MAP RUNTIME STRESS TESTS PASSED")
    print("======================================")


if __name__ == "__main__":
    main()

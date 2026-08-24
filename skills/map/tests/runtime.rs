use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_map")
}

fn schema() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("schema.surql")
        .to_string_lossy()
        .into_owned()
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("skills directory")
        .parent()
        .expect("repository root")
        .to_path_buf()
}

fn scratch(name: &str) -> PathBuf {
    let path = repo_root().join("test").join("map-rust-v2").join(name);
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create repo-local test scratch");
    path
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(bin())
        .arg("--path")
        .arg(root)
        .args(args)
        .output()
        .expect("run map")
}

fn ok(root: &Path, args: &[&str]) -> Value {
    let output = run(root, args);
    assert!(
        output.status.success(),
        "map {:?} failed\nstdout:\n{}\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("JSON stdout")
}

fn err(root: &Path, args: &[&str]) -> String {
    let output = run(root, args);
    assert!(
        !output.status.success(),
        "map {:?} unexpectedly succeeded\nstdout:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout)
    );
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_string()
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

fn new_map(name: &str) -> PathBuf {
    let root = scratch(name);
    let schema = schema();
    ok(&root, &["init", "--schema", &schema]);
    root
}

#[test]
fn init_refuses_existing_map_and_ids_use_native_shape() {
    let root = new_map("runtime-init-and-ids");
    let schema = schema();
    let message = err(&root, &["init", "--schema", &schema]);
    assert!(message.contains("already exists"));

    let intent = id(&ok(&root, &["create", "intent", "Build a government"]));
    assert_eq!(intent.len(), 20);
    assert!(intent.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
}

#[test]
fn question_readiness_soft_decision_and_closure_are_enforced() {
    let root = new_map("runtime-readiness-soft-closure");
    let intent = id(&ok(&root, &["create", "intent", "Build a government"]));
    let q1 = id(&ok(
        &root,
        &["create", "question", "What form of government?", "--intent", &intent],
    ));
    let q2 = id(&ok(
        &root,
        &["create", "question", "How is the executive selected?", "--intent", &intent],
    ));

    ok(&root, &["relate", &q2, &q1, "--dependent"]);

    let ready = ok(&root, &["get", "questions"]);
    assert_eq!(ready, serde_json::json!([q1]));

    let all_open = ok(&root, &["get", "questions", "--include-blocked"]);
    assert_eq!(all_open, serde_json::json!(sorted(vec![q1.clone(), q2.clone()])));

    let d1 = id(&ok(
        &root,
        &["create", "decision", "Democratic republic", "--question", &q1],
    ));
    let ready = ok(&root, &["get", "questions"]);
    assert_eq!(ready, serde_json::json!([q2.clone()]));

    let d2 = id(&ok(
        &root,
        &["create", "decision", "Direct election", "--question", &q2, "--soft"],
    ));
    ok(&root, &["set", &intent, "explored", "true"]);

    let message = err(&root, &["set", &intent, "close", "true"]);
    assert!(message.contains("soft"));

    ok(&root, &["set", &d2, "soft", "false"]);
    ok(&root, &["set", &intent, "close", "true"]);
    let shown = ok(&root, &["show", &intent]);
    assert_eq!(shown["closed"], true);
    assert_eq!(shown["explored"], true);

    let _ = d1;
}

#[test]
fn intent_inheritance_reopens_only_when_effective_rigor_increases() {
    let root = new_map("runtime-intent-inheritance");
    let inherited = id(&ok(&root, &["create", "intent", "Inherited"]));
    let overridden = id(&ok(
        &root,
        &["create", "intent", "Overridden", "--depth", "mvp", "--stance", "normal"],
    ));

    for intent in [&inherited, &overridden] {
        ok(&root, &["set", intent, "explored", "true"]);
        ok(&root, &["set", intent, "close", "true"]);
    }

    ok(&root, &["set", "depth", "thorough"]);
    let inherited_node = ok(&root, &["show", &inherited]);
    let overridden_node = ok(&root, &["show", &overridden]);
    assert_eq!(inherited_node["closed"], false);
    assert_eq!(inherited_node["effectiveDepth"], "thorough");
    assert_eq!(overridden_node["closed"], true);
    assert_eq!(overridden_node["effectiveDepth"], "mvp");

    ok(&root, &["set", &inherited, "close", "true"]);
    ok(&root, &["set", &inherited, "stance", "adversarial"]);
    let inherited_node = ok(&root, &["show", &inherited]);
    assert_eq!(inherited_node["closed"], false);
    assert_eq!(inherited_node["explored"], true);
}

#[test]
fn dependency_cycles_are_rejected() {
    let root = new_map("runtime-dependency-cycles");
    let a = id(&ok(&root, &["create", "intent", "A"]));
    let b = id(&ok(&root, &["create", "intent", "B"]));
    ok(&root, &["relate", &a, &b, "--dependent"]);
    let message = err(&root, &["relate", &b, &a, "--dependent"]);
    assert!(message.contains("cycle") || message.contains("invariants"));

    let q1 = id(&ok(&root, &["create", "question", "Q1", "--intent", &a]));
    let q2 = id(&ok(&root, &["create", "question", "Q2", "--intent", &a]));
    ok(&root, &["relate", &q1, &q2, "--dependent"]);
    let message = err(&root, &["relate", &q2, &q1, "--dependent"]);
    assert!(message.contains("cycle") || message.contains("invariants"));
}

#[test]
fn replacement_preserves_current_position_and_history() {
    let root = new_map("runtime-replacement-history");
    let intent = id(&ok(&root, &["create", "intent", "Government"]));
    let question = id(&ok(
        &root,
        &["create", "question", "What system?", "--intent", &intent],
    ));
    let old = id(&ok(
        &root,
        &["create", "decision", "Presidential", "--question", &question],
    ));
    let new = id(&ok(&root, &["create", "decision", "Parliamentary"]));

    ok(
        &root,
        &["replace", &old, &new, "--reason", "Changed preference"],
    );

    let shown = ok(&root, &["show", &old]);
    assert_eq!(shown["id"], new);
    assert_eq!(shown["text"], "Parliamentary");

    let answered = ok(&root, &["get", "questions", "--answered"]);
    assert_eq!(answered, serde_json::json!([question.clone()]));

    let history = ok(&root, &["history", &old]);
    assert_eq!(history["root"], old);
    assert_eq!(history["current"], new);
    assert_eq!(history["events"][0]["reason"], "Changed preference");
}

#[test]
fn destructive_delete_requires_force_when_relations_exist() {
    let root = new_map("runtime-delete-force");
    let intent = id(&ok(&root, &["create", "intent", "Government"]));
    let question = id(&ok(
        &root,
        &["create", "question", "What system?", "--intent", &intent],
    ));

    let message = err(&root, &["delete", &question]);
    assert!(message.contains("--force"));

    ok(&root, &["delete", &question, "--force"]);
    let validate = ok(&root, &["validate"]);
    assert_eq!(validate["ok"], true);
}

#[test]
fn abandoned_answer_reopens_question_and_closed_intent() {
    let root = new_map("runtime-abandoned-answer");
    let intent = id(&ok(&root, &["create", "intent", "Government"]));
    let question = id(&ok(
        &root,
        &["create", "question", "What system?", "--intent", &intent],
    ));
    let decision = id(&ok(
        &root,
        &["create", "decision", "Parliamentary", "--question", &question],
    ));
    ok(&root, &["set", &intent, "explored", "true"]);
    ok(&root, &["set", &intent, "close", "true"]);

    ok(
        &root,
        &["abandon", &decision, "--by", "user", "--reason", "Rejected"],
    );
    let shown = ok(&root, &["show", &intent]);
    assert_eq!(shown["closed"], false);
    let ready = ok(&root, &["get", "questions"]);
    assert_eq!(ready, serde_json::json!([question]));
}

#[test]
fn recovery_capsule_round_trip_and_pending_guard() {
    let root = new_map("runtime-recovery-capsule");
    ok(&root, &["session", "init"]);
    ok(&root, &["session", "exchange", "-a", "Question to user"]);
    ok(&root, &["session", "pending", "Need answer"]);

    let message = err(&root, &["session", "end"]);
    assert!(message.contains("pending"));

    ok(&root, &["session", "pending", "--clear"]);
    ok(&root, &["session", "end"]);
    let status = ok(&root, &["status"]);
    assert_eq!(status["session"], false);
}
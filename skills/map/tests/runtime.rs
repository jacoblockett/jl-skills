use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_map")
}

fn schema() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("schema.surql")
        .to_string_lossy()
        .into_owned()
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

fn new_map() -> TempDir {
    let root = tempfile::tempdir().expect("tempdir");
    let schema = schema();
    ok(root.path(), &["init", "--schema", &schema]);
    root
}

#[test]
fn init_refuses_existing_map_and_ids_use_native_shape() {
    let root = new_map();
    let schema = schema();
    let message = err(root.path(), &["init", "--schema", &schema]);
    assert!(message.contains("already exists"));

    let intent = id(&ok(root.path(), &["create", "intent", "Build a government"]));
    assert_eq!(intent.len(), 20);
    assert!(intent.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
}

#[test]
fn question_readiness_soft_decision_and_closure_are_enforced() {
    let root = new_map();
    let intent = id(&ok(root.path(), &["create", "intent", "Build a government"]));
    let q1 = id(&ok(
        root.path(),
        &["create", "question", "What form of government?", "--intent", &intent],
    ));
    let q2 = id(&ok(
        root.path(),
        &["create", "question", "How is the executive selected?", "--intent", &intent],
    ));

    ok(root.path(), &["relate", &q2, &q1, "--dependent"]);

    let ready = ok(root.path(), &["get", "questions"]);
    assert_eq!(ready, serde_json::json!([q1]));

    let all_open = ok(root.path(), &["get", "questions", "--include-blocked"]);
    assert_eq!(all_open, serde_json::json!(sorted(vec![q1.clone(), q2.clone()])));

    let d1 = id(&ok(
        root.path(),
        &["create", "decision", "Democratic republic", "--question", &q1],
    ));
    let ready = ok(root.path(), &["get", "questions"]);
    assert_eq!(ready, serde_json::json!([q2.clone()]));

    let d2 = id(&ok(
        root.path(),
        &["create", "decision", "Direct election", "--question", &q2, "--soft"],
    ));
    ok(root.path(), &["set", &intent, "explored", "true"]);

    let message = err(root.path(), &["set", &intent, "close", "true"]);
    assert!(message.contains("soft"));

    ok(root.path(), &["set", &d2, "soft", "false"]);
    ok(root.path(), &["set", &intent, "close", "true"]);
    let shown = ok(root.path(), &["show", &intent]);
    assert_eq!(shown["closed"], true);
    assert_eq!(shown["explored"], true);

    let _ = d1;
}

#[test]
fn intent_inheritance_reopens_only_when_effective_rigor_increases() {
    let root = new_map();
    let inherited = id(&ok(root.path(), &["create", "intent", "Inherited"]));
    let overridden = id(&ok(
        root.path(),
        &["create", "intent", "Overridden", "--depth", "mvp", "--stance", "normal"],
    ));

    for intent in [&inherited, &overridden] {
        ok(root.path(), &["set", intent, "explored", "true"]);
        ok(root.path(), &["set", intent, "close", "true"]);
    }

    ok(root.path(), &["set", "depth", "thorough"]);
    let inherited_node = ok(root.path(), &["show", &inherited]);
    let overridden_node = ok(root.path(), &["show", &overridden]);
    assert_eq!(inherited_node["closed"], false);
    assert_eq!(inherited_node["effectiveDepth"], "thorough");
    assert_eq!(overridden_node["closed"], true);
    assert_eq!(overridden_node["effectiveDepth"], "mvp");

    ok(root.path(), &["set", &inherited, "close", "true"]);
    ok(root.path(), &["set", &inherited, "stance", "adversarial"]);
    let inherited_node = ok(root.path(), &["show", &inherited]);
    assert_eq!(inherited_node["closed"], false);
    assert_eq!(inherited_node["explored"], true);
}

#[test]
fn dependency_cycles_are_rejected() {
    let root = new_map();
    let a = id(&ok(root.path(), &["create", "intent", "A"]));
    let b = id(&ok(root.path(), &["create", "intent", "B"]));
    ok(root.path(), &["relate", &a, &b, "--dependent"]);
    let message = err(root.path(), &["relate", &b, &a, "--dependent"]);
    assert!(message.contains("cycle") || message.contains("invariants"));

    let q1 = id(&ok(root.path(), &["create", "question", "Q1", "--intent", &a]));
    let q2 = id(&ok(root.path(), &["create", "question", "Q2", "--intent", &a]));
    ok(root.path(), &["relate", &q1, &q2, "--dependent"]);
    let message = err(root.path(), &["relate", &q2, &q1, "--dependent"]);
    assert!(message.contains("cycle") || message.contains("invariants"));
}

#[test]
fn replacement_preserves_current_position_and_history() {
    let root = new_map();
    let intent = id(&ok(root.path(), &["create", "intent", "Government"]));
    let question = id(&ok(
        root.path(),
        &["create", "question", "What system?", "--intent", &intent],
    ));
    let old = id(&ok(
        root.path(),
        &["create", "decision", "Presidential", "--question", &question],
    ));
    let new = id(&ok(root.path(), &["create", "decision", "Parliamentary"]));

    ok(
        root.path(),
        &["replace", &old, &new, "--reason", "Changed preference"],
    );

    let shown = ok(root.path(), &["show", &old]);
    assert_eq!(shown["id"], new);
    assert_eq!(shown["text"], "Parliamentary");

    let answered = ok(root.path(), &["get", "questions", "--answered"]);
    assert_eq!(answered, serde_json::json!([question.clone()]));

    let history = ok(root.path(), &["history", &old]);
    assert_eq!(history["root"], old);
    assert_eq!(history["current"], new);
    assert_eq!(history["events"][0]["reason"], "Changed preference");
}

#[test]
fn destructive_delete_requires_force_when_relations_exist() {
    let root = new_map();
    let intent = id(&ok(root.path(), &["create", "intent", "Government"]));
    let question = id(&ok(
        root.path(),
        &["create", "question", "What system?", "--intent", &intent],
    ));

    let message = err(root.path(), &["delete", &question]);
    assert!(message.contains("--force"));

    ok(root.path(), &["delete", &question, "--force"]);
    let validate = ok(root.path(), &["validate"]);
    assert_eq!(validate["ok"], true);
}

#[test]
fn abandoned_answer_reopens_question_and_closed_intent() {
    let root = new_map();
    let intent = id(&ok(root.path(), &["create", "intent", "Government"]));
    let question = id(&ok(
        root.path(),
        &["create", "question", "What system?", "--intent", &intent],
    ));
    let decision = id(&ok(
        root.path(),
        &["create", "decision", "Parliamentary", "--question", &question],
    ));
    ok(root.path(), &["set", &intent, "explored", "true"]);
    ok(root.path(), &["set", &intent, "close", "true"]);

    ok(
        root.path(),
        &["abandon", &decision, "--by", "user", "--reason", "Rejected"],
    );
    let shown = ok(root.path(), &["show", &intent]);
    assert_eq!(shown["closed"], false);
    let ready = ok(root.path(), &["get", "questions"]);
    assert_eq!(ready, serde_json::json!([question]));
}

#[test]
fn recovery_capsule_round_trip_and_pending_guard() {
    let root = new_map();
    ok(root.path(), &["session", "init"]);
    ok(root.path(), &["session", "exchange", "-a", "Question to user"]);
    ok(root.path(), &["session", "pending", "Need answer"]);

    let message = err(root.path(), &["session", "end"]);
    assert!(message.contains("pending"));

    ok(root.path(), &["session", "pending", "--clear"]);
    ok(root.path(), &["session", "end"]);
    let status = ok(root.path(), &["status"]);
    assert_eq!(status["session"], false);
}

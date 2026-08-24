use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_map")
}

fn schema() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("schema.surql")
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(bin())
        .arg("--path")
        .arg(root)
        .args(args)
        .output()
        .expect("run map")
}

fn run_from(cwd: &Path, args: &[&str]) -> Output {
    Command::new(bin())
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("run map")
}

fn parse_ok(output: Output) -> Value {
    assert!(
        output.status.success(),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("JSON stdout")
}

fn ok(root: &Path, args: &[&str]) -> Value {
    parse_ok(run(root, args))
}

fn err(root: &Path, args: &[&str]) -> String {
    let output = run(root, args);
    assert!(!output.status.success(), "unexpected success: {args:?}");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn id(value: &Value) -> String {
    value["id"].as_str().expect("id").to_string()
}

fn new_map() -> TempDir {
    let root = tempfile::tempdir().expect("tempdir");
    let schema = schema().to_string_lossy().into_owned();
    ok(root.path(), &["init", "--schema", &schema]);
    root
}

fn toml_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "\\\\")
}

#[test]
fn explicit_config_path_resolves_and_invalid_selection_does_not_fallback() {
    let root = new_map();
    let config_dir = tempfile::tempdir().expect("config tempdir");
    fs::write(
        config_dir.path().join(".maprc"),
        format!("path = \"{}\"\n", toml_path(root.path())),
    )
    .unwrap();

    let status = parse_ok(run_from(
        config_dir.path(),
        &["--config", config_dir.path().to_string_lossy().as_ref(), "status"],
    ));
    assert_eq!(status["depth"], "mvp");

    let missing = config_dir.path().join("missing-project");
    fs::write(
        config_dir.path().join(".maprc"),
        format!("path = \"{}\"\n", toml_path(&missing)),
    )
    .unwrap();

    // cwd has a valid Map, but the explicitly selected config path must win and fail.
    let output = run_from(
        root.path(),
        &["--config", config_dir.path().to_string_lossy().as_ref(), "status"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("no .map exists"));
}

#[test]
fn adding_dependency_reopens_closed_source_even_when_target_is_closed() {
    let root = new_map();
    let source = id(&ok(root.path(), &["create", "intent", "Source"]));
    let target = id(&ok(root.path(), &["create", "intent", "Target"]));

    for intent in [&source, &target] {
        ok(root.path(), &["set", intent, "explored", "true"]);
        ok(root.path(), &["set", intent, "close", "true"]);
    }

    ok(root.path(), &["relate", &source, &target, "--dependent"]);
    assert_eq!(ok(root.path(), &["show", &source])["closed"], false);
    assert_eq!(ok(root.path(), &["show", &target])["closed"], true);
    assert_eq!(ok(root.path(), &["show", &source])["explored"], true);
}

#[test]
fn adding_question_reopens_closed_intent_without_resetting_explored() {
    let root = new_map();
    let intent = id(&ok(root.path(), &["create", "intent", "Government"]));
    ok(root.path(), &["set", &intent, "explored", "true"]);
    ok(root.path(), &["set", &intent, "close", "true"]);

    id(&ok(
        root.path(),
        &["create", "question", "What system?", "--intent", &intent],
    ));

    let shown = ok(root.path(), &["show", &intent]);
    assert_eq!(shown["closed"], false);
    assert_eq!(shown["explored"], true);
}

#[test]
fn decision_provenance_rules_are_enforced() {
    let root = new_map();

    let message = err(
        root.path(),
        &["create", "decision", "Assistant choice", "--source", "assistant"],
    );
    assert!(message.contains("assistant-reasoning"));

    let assistant = ok(
        root.path(),
        &[
            "create",
            "decision",
            "Assistant choice",
            "--source",
            "assistant",
            "--assistant-reasoning",
            "Derived from the user's stated priorities",
        ],
    );
    assert!(assistant["id"].is_string());

    let message = err(
        root.path(),
        &[
            "create",
            "decision",
            "User choice",
            "--source",
            "user",
            "--assistant-reasoning",
            "not allowed",
        ],
    );
    assert!(message.contains("invalid when --source user"));
}

#[test]
fn unrelate_removes_only_the_inferred_dependency() {
    let root = new_map();
    let intent = id(&ok(root.path(), &["create", "intent", "Government"]));
    let q1 = id(&ok(root.path(), &["create", "question", "Q1", "--intent", &intent]));
    let q2 = id(&ok(root.path(), &["create", "question", "Q2", "--intent", &intent]));

    ok(root.path(), &["relate", &q2, &q1, "--dependent"]);
    assert_eq!(ok(root.path(), &["get", "questions"]), serde_json::json!([q1.clone()]));

    ok(root.path(), &["unrelate", &q2, &q1, "--dependent"]);
    assert_eq!(
        ok(root.path(), &["get", "questions"]),
        serde_json::json!([q1, q2])
    );

    let message = err(root.path(), &["unrelate", &q2, &q2, "--dependent"]);
    assert!(message.contains("does not exist") || message.contains("relationship"));
}

#[test]
fn answer_cardinality_and_illegal_relation_shapes_reject() {
    let root = new_map();
    let intent = id(&ok(root.path(), &["create", "intent", "Government"]));
    let question = id(&ok(
        root.path(),
        &["create", "question", "What system?", "--intent", &intent],
    ));
    let d1 = id(&ok(
        root.path(),
        &["create", "decision", "Parliamentary", "--question", &question],
    ));
    let d2 = id(&ok(root.path(), &["create", "decision", "Presidential"]));

    let message = err(root.path(), &["relate", &question, &d2]);
    assert!(message.contains("current answers") || message.contains("invariants"));

    let message = err(root.path(), &["relate", &d1, &question]);
    assert!(message.contains("no legal v2 relationship"));

    let q2 = id(&ok(root.path(), &["create", "question", "Q2", "--intent", &intent]));
    let message = err(root.path(), &["relate", &question, &q2]);
    assert!(message.contains("requires --dependent"));
}

#[test]
fn keywords_and_unicode_are_searchable_and_round_trip() {
    let root = new_map();
    let fact = id(&ok(
        root.path(),
        &["create", "fact", "헌법은 최고 법규다", "--made-by", "assistant"],
    ));
    ok(
        root.path(),
        &["set", &fact, "keywords", "[\"constitution\",\"헌법\"]"],
    );

    let results = ok(root.path(), &["search", "헌법"]);
    assert_eq!(results[0], fact);
    let shown = ok(root.path(), &["show", &fact]);
    assert_eq!(shown["text"], "헌법은 최고 법규다");
    assert_eq!(shown["keywords"], serde_json::json!(["constitution", "헌법"]));
}

#[test]
fn in_place_replacement_removes_old_node_but_retains_replacement_metadata() {
    let root = new_map();
    let old = id(&ok(root.path(), &["create", "idea", "Old idea"]));
    let new = id(&ok(root.path(), &["create", "idea", "New idea"]));

    ok(
        root.path(),
        &[
            "replace",
            &old,
            &new,
            "--reason",
            "Clean replacement",
            "--in-place",
        ],
    );

    let shown = ok(root.path(), &["show", &old]);
    assert_eq!(shown["id"], new);
    assert_eq!(shown["text"], "New idea");

    let history = ok(root.path(), &["history", &old]);
    assert_eq!(history["events"][0]["mode"], "in_place");
    assert!(history["nodes"][0]["node"].is_null());
    assert_eq!(ok(root.path(), &["validate"])["ok"], true);
}

#[test]
fn invalid_set_property_rejects_instead_of_becoming_generic_editing() {
    let root = new_map();
    let idea = id(&ok(root.path(), &["create", "idea", "Maybe bicameral"]));
    let message = err(root.path(), &["set", &idea, "soft", "true"]);
    assert!(message.contains("does not exist on idea"));
}

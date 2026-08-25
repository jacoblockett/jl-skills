use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_map")
}

fn schema() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("schema.surql")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("skills directory")
        .parent()
        .expect("repository root")
        .to_path_buf()
}

fn test_home() -> PathBuf {
    let name = std::thread::current()
        .name()
        .unwrap_or("contract")
        .replace("::", "-");
    let path = repo_root().join("test").join("map-rust-v2-homes").join(name);
    fs::create_dir_all(&path).expect("create test home");
    path
}

fn reset_test_home() {
    let path = test_home();
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("reset test home");
}

fn scratch(name: &str) -> PathBuf {
    let path = repo_root().join("test").join("map-rust-v2").join(name);
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create repo-local test scratch");
    path
}

fn run(root: &Path, args: &[&str]) -> Output {
    let home = test_home();
    Command::new(bin())
        .env("USERPROFILE", &home)
        .env("HOME", &home)
        .arg("--path")
        .arg(root)
        .args(args)
        .output()
        .expect("run map")
}

fn run_from(cwd: &Path, args: &[&str]) -> Output {
    let home = test_home();
    Command::new(bin())
        .env("USERPROFILE", &home)
        .env("HOME", &home)
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

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

fn new_map(name: &str) -> PathBuf {
    reset_test_home();
    let root = scratch(name);
    let schema = schema().to_string_lossy().into_owned();
    ok(&root, &["init", "--schema", &schema]);
    root
}

fn toml_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "\\\\")
}

#[test]
fn explicit_config_path_resolves_and_invalid_selection_does_not_fallback() {
    let root = new_map("contract-explicit-config-map");
    let config_dir = scratch("contract-explicit-config-dir");
    fs::write(
        config_dir.join(".maprc"),
        format!("path = \"{}\"\n", toml_path(&root)),
    )
    .unwrap();
    let config = config_dir.to_string_lossy().into_owned();

    let status = parse_ok(run_from(&config_dir, &["--config", &config, "status"]));
    assert_eq!(status["depth"], "mvp");

    let missing = config_dir.join("missing-project");
    fs::write(
        config_dir.join(".maprc"),
        format!("path = \"{}\"\n", toml_path(&missing)),
    )
    .unwrap();

    let output = run_from(&root, &["--config", &config, "status"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("no .map exists"));
}

#[test]
fn adding_dependency_reopens_closed_source_even_when_target_is_closed() {
    let root = new_map("contract-dependency-reopens");
    let source = id(&ok(&root, &["create", "intent", "Source"]));
    let target = id(&ok(&root, &["create", "intent", "Target"]));

    for intent in [&source, &target] {
        ok(&root, &["set", intent, "explored", "true"]);
        ok(&root, &["set", intent, "close", "true"]);
    }

    ok(&root, &["relate", &source, &target, "--dependent"]);
    assert_eq!(ok(&root, &["show", &source])["closed"], false);
    assert_eq!(ok(&root, &["show", &target])["closed"], true);
    assert_eq!(ok(&root, &["show", &source])["explored"], true);
}

#[test]
fn adding_question_reopens_closed_intent_without_resetting_explored() {
    let root = new_map("contract-question-reopens");
    let intent = id(&ok(&root, &["create", "intent", "Government"]));
    ok(&root, &["set", &intent, "explored", "true"]);
    ok(&root, &["set", &intent, "close", "true"]);

    id(&ok(
        &root,
        &["create", "question", "What system?", "--intent", &intent],
    ));

    let shown = ok(&root, &["show", &intent]);
    assert_eq!(shown["closed"], false);
    assert_eq!(shown["explored"], true);
}

#[test]
fn decision_provenance_rules_are_enforced() {
    let root = new_map("contract-decision-provenance");

    let message = err(
        &root,
        &["create", "decision", "Assistant choice", "--source", "assistant"],
    );
    assert!(message.contains("assistant-reasoning"));

    let assistant = ok(
        &root,
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
        &root,
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
    let root = new_map("contract-unrelate");
    let intent = id(&ok(&root, &["create", "intent", "Government"]));
    let q1 = id(&ok(&root, &["create", "question", "Q1", "--intent", &intent]));
    let q2 = id(&ok(&root, &["create", "question", "Q2", "--intent", &intent]));

    ok(&root, &["relate", &q2, &q1, "--dependent"]);
    assert_eq!(ok(&root, &["get", "questions"]), serde_json::json!([q1.clone()]));

    ok(&root, &["unrelate", &q2, &q1, "--dependent"]);
    assert_eq!(
        ok(&root, &["get", "questions"]),
        serde_json::json!(sorted(vec![q1, q2.clone()]))
    );

    let message = err(&root, &["unrelate", &q2, &q2, "--dependent"]);
    assert!(message.contains("does not exist") || message.contains("relationship"));
}

#[test]
fn answer_cardinality_and_illegal_relation_shapes_reject() {
    let root = new_map("contract-relation-cardinality");
    let intent = id(&ok(&root, &["create", "intent", "Government"]));
    let question = id(&ok(
        &root,
        &["create", "question", "What system?", "--intent", &intent],
    ));
    let d1 = id(&ok(
        &root,
        &["create", "decision", "Parliamentary", "--question", &question],
    ));
    let d2 = id(&ok(&root, &["create", "decision", "Presidential"]));

    let message = err(&root, &["relate", &question, &d2]);
    assert!(message.contains("current answers") || message.contains("invariants"));

    let message = err(&root, &["relate", &d1, &question]);
    assert!(message.contains("no legal v2 relationship"));

    let q2 = id(&ok(&root, &["create", "question", "Q2", "--intent", &intent]));
    let message = err(&root, &["relate", &question, &q2]);
    assert!(message.contains("requires --dependent"));
}

#[test]
fn keywords_and_unicode_are_searchable_and_round_trip() {
    let root = new_map("contract-keywords-unicode");
    let fact = id(&ok(
        &root,
        &["create", "fact", "헌법은 최고 법규다", "--made-by", "assistant"],
    ));
    ok(
        &root,
        &["set", &fact, "keywords", "[\"constitution\",\"헌법\"]"],
    );

    let results = ok(&root, &["search", "헌법"]);
    assert_eq!(results[0], fact);
    let shown = ok(&root, &["show", &fact]);
    assert_eq!(shown["text"], "헌법은 최고 법규다");
    assert_eq!(shown["keywords"], serde_json::json!(["constitution", "헌법"]));
}

#[test]
fn in_place_replacement_removes_old_node_but_retains_replacement_metadata() {
    let root = new_map("contract-in-place-replacement");
    let old = id(&ok(&root, &["create", "idea", "Old idea"]));
    let new = id(&ok(&root, &["create", "idea", "New idea"]));

    ok(
        &root,
        &[
            "replace",
            &old,
            &new,
            "--reason",
            "Clean replacement",
            "--in-place",
        ],
    );

    let shown = ok(&root, &["show", &old]);
    assert_eq!(shown["id"], new);
    assert_eq!(shown["text"], "New idea");

    let history = ok(&root, &["history", &old]);
    assert_eq!(history["events"][0]["mode"], "in_place");
    assert!(history["nodes"][0]["node"].is_null());
    assert_eq!(ok(&root, &["validate"])["ok"], true);
}

#[test]
fn invalid_set_property_rejects_instead_of_becoming_generic_editing() {
    let root = new_map("contract-invalid-set");
    let idea = id(&ok(&root, &["create", "idea", "Maybe bicameral"]));
    let message = err(&root, &["set", &idea, "soft", "true"]);
    assert!(message.contains("does not exist on idea"));
}

#[test]
fn every_node_kind_supports_abandonment() {
    let root = new_map("contract-abandonment");
    let owner = id(&ok(&root, &["create", "intent", "Owner"]));
    let question = id(&ok(&root, &["create", "question", "Question", "--intent", &owner]));
    let decision = id(&ok(&root, &["create", "decision", "Decision"]));
    let idea = id(&ok(&root, &["create", "idea", "Idea"]));
    let fact = id(&ok(&root, &["create", "fact", "Fact"]));
    let standalone_intent = id(&ok(&root, &["create", "intent", "Standalone"]));

    for node in [&question, &decision, &idea, &fact, &standalone_intent] {
        ok(
            &root,
            &["abandon", node, "--by", "user", "--reason", "No longer relevant"],
        );
        let shown = ok(&root, &["show", node]);
        assert_eq!(shown["abandoned"], true);
        assert_eq!(shown["abandonedBy"], "user");
        assert_eq!(shown["abandonedReason"], "No longer relevant");
    }
}

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn source_bin() -> &'static str {
    env!("CARGO_BIN_EXE_map")
}

fn source_schema() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("schema.surql")
}

fn scratch() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("skills directory")
        .parent()
        .expect("repository root")
        .join("test")
        .join("map-scoped-runtime")
}

#[test]
fn installed_runtime_resolves_schema_from_its_scope_local_tooling_root() {
    let root = scratch();
    let _ = fs::remove_dir_all(&root);

    let tooling = root.join(".jl-skills").join("map");
    let bin_dir = tooling.join("bin");
    let project = root.join("project");
    fs::create_dir_all(&bin_dir).expect("create scoped runtime bin");
    fs::create_dir_all(&project).expect("create project");

    let runtime = bin_dir.join(format!("map{}", std::env::consts::EXE_SUFFIX));
    fs::copy(source_bin(), &runtime).expect("copy Map runtime");
    fs::copy(source_schema(), tooling.join("schema.surql")).expect("copy Map schema");

    let home = root.join("home");
    fs::create_dir_all(&home).expect("create isolated home");
    let output = Command::new(&runtime)
        .env("USERPROFILE", &home)
        .env("HOME", &home)
        .arg("--path")
        .arg(&project)
        .arg("init")
        .output()
        .expect("run scoped Map runtime");

    assert!(
        output.status.success(),
        "scope-local init failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(project.join(".map").join("project.json").is_file());
    assert!(!home.join(".jl-skills").join("map").exists());
}

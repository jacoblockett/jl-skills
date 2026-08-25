use std::fs::OpenOptions;
use std::io::{self, IsTerminal, Write};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIdentity {
    project_id: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRegistration {
    project_id: String,
    path: String,
    created_at_ms: i64,
    last_seen_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProjectRegistry {
    #[serde(default)]
    projects: Vec<ProjectRegistration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistrationOutcome {
    Proceed,
    ExitSuccess,
}

struct RegistryLock {
    path: PathBuf,
}

impl Drop for RegistryLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn map_registry_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".jl-skills").join("map").join("registry.json"))
}

fn map_registry_lock_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".jl-skills").join("map").join("registry.lock"))
}

fn acquire_registry_lock() -> Result<RegistryLock> {
    let path = map_registry_lock_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating Map registry directory {}", parent.display()))?;
    }
    for _ in 0..200 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(RegistryLock { path });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .map(|age| age > Duration::from_secs(30))
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error).context("acquiring Map registry lock"),
        }
    }
    bail!("timed out waiting for Map project registry lock")
}

fn load_project_registry_unlocked() -> Result<ProjectRegistry> {
    let path = map_registry_path()?;
    if !path.exists() {
        return Ok(ProjectRegistry::default());
    }
    let text = fs::read_to_string(&path)
        .with_context(|| format!("reading Map project registry {}", path.display()))?;
    let registry: ProjectRegistry = serde_json::from_str(&text)
        .with_context(|| format!("parsing Map project registry {}", path.display()))?;
    validate_project_registry(&registry)?;
    Ok(registry)
}

fn validate_project_registry(registry: &ProjectRegistry) -> Result<()> {
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for project in &registry.projects {
        if !valid_project_id(&project.project_id) {
            bail!("Map project registry contains invalid project ID {}", project.project_id);
        }
        if project.path.trim().is_empty() {
            bail!("Map project registry contains an empty project path");
        }
        if !ids.insert(project.project_id.clone()) {
            bail!("Map project registry contains duplicate project ID {}", project.project_id);
        }
        let path_key = path_key(&project.path);
        if !paths.insert(path_key) {
            bail!("Map project registry contains duplicate project path {}", project.path);
        }
    }
    Ok(())
}

fn save_project_registry_unlocked(registry: &ProjectRegistry) -> Result<()> {
    validate_project_registry(registry)?;
    let path = map_registry_path()?;
    let parent = path.parent().ok_or_else(|| anyhow!("invalid Map registry path"))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("creating Map registry directory {}", parent.display()))?;
    let tmp = parent.join(format!(
        ".registry-{}-{}.tmp",
        std::process::id(),
        now_ms()
    ));
    fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(registry)?))
        .with_context(|| format!("writing temporary Map registry {}", tmp.display()))?;
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("replacing Map registry {}", path.display()))?;
    }
    fs::rename(&tmp, &path)
        .with_context(|| format!("committing Map registry {}", path.display()))?;
    Ok(())
}

fn read_project_registry() -> Result<ProjectRegistry> {
    let _lock = acquire_registry_lock()?;
    load_project_registry_unlocked()
}

fn mutate_project_registry<T>(f: impl FnOnce(&mut ProjectRegistry) -> Result<T>) -> Result<T> {
    let _lock = acquire_registry_lock()?;
    let mut registry = load_project_registry_unlocked()?;
    let result = f(&mut registry)?;
    save_project_registry_unlocked(&registry)?;
    Ok(result)
}

fn project_identity_path(map_dir: &Path) -> PathBuf {
    map_dir.join("project.json")
}

fn valid_project_id(id: &str) -> bool {
    id.len() == 20
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn generate_project_id(registry: &ProjectRegistry) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    loop {
        let id: String = (0..20)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect();
        if !registry.projects.iter().any(|project| project.project_id == id) {
            return id;
        }
    }
}

fn read_project_identity(map_dir: &Path) -> Result<Option<ProjectIdentity>> {
    let path = project_identity_path(map_dir);
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        bail!("Map project identity {} is not a file", path.display());
    }
    let text = fs::read_to_string(&path)
        .with_context(|| format!("reading Map project identity {}", path.display()))?;
    let identity: ProjectIdentity = serde_json::from_str(&text)
        .with_context(|| format!("parsing Map project identity {}", path.display()))?;
    if !valid_project_id(&identity.project_id) {
        bail!("Map project identity contains an invalid project ID");
    }
    Ok(Some(identity))
}

fn write_project_identity(map_dir: &Path, identity: &ProjectIdentity) -> Result<()> {
    let path = project_identity_path(map_dir);
    let tmp = map_dir.join(format!(
        ".project-{}-{}.tmp",
        std::process::id(),
        now_ms()
    ));
    fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(identity)?))
        .with_context(|| format!("writing Map project identity {}", tmp.display()))?;
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("replacing Map project identity {}", path.display()))?;
    }
    fs::rename(&tmp, &path)
        .with_context(|| format!("committing Map project identity {}", path.display()))?;
    Ok(())
}

fn project_root(map_dir: &Path) -> Result<PathBuf> {
    map_dir
        .parent()
        .map(|path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
        .ok_or_else(|| anyhow!("cannot determine project root for {}", map_dir.display()))
}

fn normalized_project_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

fn same_project_path(a: &str, b: &str) -> bool {
    path_key(a) == path_key(b)
}

fn register_initialized_map(map_dir: &Path) -> Result<ProjectIdentity> {
    let root = project_root(map_dir)?;
    let current_path = normalized_project_path(&root);
    let _lock = acquire_registry_lock()?;
    let mut registry = load_project_registry_unlocked()?;
    let identity = ProjectIdentity {
        project_id: generate_project_id(&registry),
        created_at_ms: now_ms(),
    };
    write_project_identity(map_dir, &identity)?;
    registry
        .projects
        .retain(|project| !same_project_path(&project.path, &current_path));
    registry.projects.push(ProjectRegistration {
        project_id: identity.project_id.clone(),
        path: current_path,
        created_at_ms: identity.created_at_ms,
        last_seen_ms: now_ms(),
    });
    save_project_registry_unlocked(&registry)?;
    Ok(identity)
}

fn identity_at_registered_path(path: &str) -> Result<Option<ProjectIdentity>> {
    let map_dir = PathBuf::from(path).join(".map");
    if !map_dir.is_dir() {
        return Ok(None);
    }
    read_project_identity(&map_dir)?.ok_or_else(|| {
        anyhow!(
            "registered Map at {} exists but has no project identity",
            map_dir.display()
        )
    }).map(Some)
}

fn touch_registration(project_id: &str, current_path: &str) -> Result<()> {
    mutate_project_registry(|registry| {
        let entry = registry
            .projects
            .iter_mut()
            .find(|project| project.project_id == project_id)
            .ok_or_else(|| anyhow!("Map project {project_id} is not registered"))?;
        entry.path = current_path.to_string();
        entry.last_seen_ms = now_ms();
        Ok(())
    })
}

fn is_interactive_terminal() -> bool {
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

fn prompt_number(message: &str, choices: &[&str]) -> Result<usize> {
    println!("{message}");
    for (index, choice) in choices.iter().enumerate() {
        println!("  {}. {}", index + 1, choice);
    }
    loop {
        print!("> ");
        io::stdout().flush()?;
        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        let trimmed = input.trim();
        if let Ok(value) = trimmed.parse::<usize>() {
            if value >= 1 && value <= choices.len() {
                return Ok(value - 1);
            }
        }
        println!("Choose a number from 1 to {}.", choices.len());
    }
}

fn prompt_confirm(message: &str) -> Result<bool> {
    loop {
        print!("{message} [y/N] ");
        io::stdout().flush()?;
        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        match input.trim().to_lowercase().as_str() {
            "y" | "yes" => return Ok(true),
            "" | "n" | "no" => return Ok(false),
            _ => println!("Enter y or n."),
        }
    }
}

fn separate_current_copy(map_dir: &Path, original_identity: &ProjectIdentity) -> Result<ProjectIdentity> {
    let root = project_root(map_dir)?;
    let current_path = normalized_project_path(&root);
    let identity_path = project_identity_path(map_dir);
    let old_bytes = fs::read(&identity_path).ok();
    let _lock = acquire_registry_lock()?;
    let mut registry = load_project_registry_unlocked()?;
    let new_identity = ProjectIdentity {
        project_id: generate_project_id(&registry),
        created_at_ms: now_ms(),
    };
    write_project_identity(map_dir, &new_identity)?;
    registry.projects.push(ProjectRegistration {
        project_id: new_identity.project_id.clone(),
        path: current_path,
        created_at_ms: new_identity.created_at_ms,
        last_seen_ms: now_ms(),
    });
    if let Err(error) = save_project_registry_unlocked(&registry) {
        if let Some(bytes) = old_bytes {
            let _ = fs::write(&identity_path, bytes);
        } else {
            let _ = fs::remove_file(&identity_path);
        }
        return Err(error);
    }
    let _ = original_identity;
    Ok(new_identity)
}

async fn recover_project_registration(store: &Store, reason: &str) -> Result<RegistrationOutcome> {
    if !is_interactive_terminal() {
        bail!(
            "{reason}; Map project identity recovery requires an interactive user"
        );
    }
    println!("This Map's project identity is damaged or does not match the registry.\n");
    let choice = prompt_number(
        "What would you like to do?",
        &["Register and recover this Map", "Cancel"],
    )?;
    if choice == 1 {
        bail!("Map project identity recovery cancelled");
    }

    let graph = store.graph().await?;
    let errors = validate_graph_semantics(&graph);
    if !errors.is_empty() {
        bail!("Map recovery validation failed: {}", errors.join("; "));
    }

    let root = project_root(&store.map_dir)?;
    let current_path = normalized_project_path(&root);
    let identity_path = project_identity_path(&store.map_dir);
    let old_bytes = fs::read(&identity_path).ok();
    let existing_identity = read_project_identity(&store.map_dir).ok().flatten();

    let _lock = acquire_registry_lock()?;
    let mut registry = load_project_registry_unlocked()?;
    let candidate = existing_identity
        .filter(|identity| {
            valid_project_id(&identity.project_id)
                && !registry.projects.iter().any(|project| {
                    project.project_id == identity.project_id
                        && !same_project_path(&project.path, &current_path)
                })
        })
        .unwrap_or_else(|| ProjectIdentity {
            project_id: generate_project_id(&registry),
            created_at_ms: now_ms(),
        });

    write_project_identity(&store.map_dir, &candidate)?;
    registry.projects.retain(|project| {
        !same_project_path(&project.path, &current_path)
            && project.project_id != candidate.project_id
    });
    registry.projects.push(ProjectRegistration {
        project_id: candidate.project_id.clone(),
        path: current_path,
        created_at_ms: candidate.created_at_ms,
        last_seen_ms: now_ms(),
    });
    if let Err(error) = save_project_registry_unlocked(&registry) {
        if let Some(bytes) = old_bytes {
            let _ = fs::write(&identity_path, bytes);
        } else {
            let _ = fs::remove_file(&identity_path);
        }
        return Err(error);
    }
    Ok(RegistrationOutcome::Proceed)
}

async fn resolve_duplicate_project(
    store: &Store,
    identity: &ProjectIdentity,
    registered_path: &str,
    current_path: &str,
) -> Result<RegistrationOutcome> {
    if !is_interactive_terminal() {
        bail!(
            "duplicate Map project identity {}: registered at {} and also opened at {}; user resolution is required",
            identity.project_id,
            registered_path,
            current_path
        );
    }

    println!(
        "This Map appears to have been copied.\n\nOriginal: {}\nCopy:     {}\n",
        registered_path, current_path
    );
    let choice = prompt_number(
        "What would you like to do?",
        &[
            "Keep both and make this a separate Map",
            "Remove one of these Maps",
            "Cancel",
        ],
    )?;
    match choice {
        0 => {
            separate_current_copy(&store.map_dir, identity)?;
            Ok(RegistrationOutcome::Proceed)
        }
        1 => {
            let remove = prompt_number(
                "Which Map should be removed?",
                &["Original", "Copy", "Cancel"],
            )?;
            if remove == 2 {
                bail!("duplicate Map resolution cancelled");
            }
            let target_root = if remove == 0 {
                PathBuf::from(registered_path)
            } else {
                PathBuf::from(current_path)
            };
            let target_map = target_root.join(".map");
            if !prompt_confirm(&format!(
                "Permanently delete Map data at {}?",
                target_map.display()
            ))? {
                bail!("duplicate Map removal cancelled");
            }
            fs::remove_dir_all(&target_map)
                .with_context(|| format!("removing Map data {}", target_map.display()))?;
            if remove == 0 {
                touch_registration(&identity.project_id, current_path)?;
                Ok(RegistrationOutcome::Proceed)
            } else {
                emit(json!({ "ok": true, "removedMap": target_map }))?;
                Ok(RegistrationOutcome::ExitSuccess)
            }
        }
        _ => bail!("duplicate Map resolution cancelled"),
    }
}

async fn ensure_project_registration(store: &Store) -> Result<RegistrationOutcome> {
    let root = project_root(&store.map_dir)?;
    let current_path = normalized_project_path(&root);
    let identity = match read_project_identity(&store.map_dir) {
        Ok(Some(identity)) => identity,
        Ok(None) => {
            return recover_project_registration(store, "Map project identity is missing").await;
        }
        Err(error) => {
            return recover_project_registration(
                store,
                &format!("Map project identity is invalid: {error}"),
            )
            .await;
        }
    };

    let registry = match read_project_registry() {
        Ok(registry) => registry,
        Err(error) => {
            return recover_project_registration(
                store,
                &format!("Map project registry is invalid: {error}"),
            )
            .await;
        }
    };

    let by_id = registry
        .projects
        .iter()
        .find(|project| project.project_id == identity.project_id)
        .cloned();
    let by_path = registry
        .projects
        .iter()
        .find(|project| same_project_path(&project.path, &current_path))
        .cloned();

    if let Some(path_entry) = &by_path {
        if path_entry.project_id != identity.project_id {
            return recover_project_registration(
                store,
                &format!(
                    "registry path {} belongs to project {}, but this Map reports {}",
                    current_path, path_entry.project_id, identity.project_id
                ),
            )
            .await;
        }
    }

    let Some(registration) = by_id else {
        return recover_project_registration(
            store,
            &format!("Map project {} is not registered", identity.project_id),
        )
        .await;
    };

    if same_project_path(&registration.path, &current_path) {
        touch_registration(&identity.project_id, &current_path)?;
        return Ok(RegistrationOutcome::Proceed);
    }

    match identity_at_registered_path(&registration.path) {
        Ok(None) => {
            touch_registration(&identity.project_id, &current_path)?;
            Ok(RegistrationOutcome::Proceed)
        }
        Ok(Some(original)) if original.project_id == identity.project_id => {
            resolve_duplicate_project(store, &identity, &registration.path, &current_path).await
        }
        Ok(Some(original)) => {
            recover_project_registration(
                store,
                &format!(
                    "registered path {} now contains project {} instead of {}",
                    registration.path, original.project_id, identity.project_id
                ),
            )
            .await
        }
        Err(error) => {
            recover_project_registration(
                store,
                &format!("registered Map at {} is inconsistent: {error}", registration.path),
            )
            .await
        }
    }
}

fn current_project_id(map_dir: &Path) -> Result<String> {
    read_project_identity(map_dir)?
        .map(|identity| identity.project_id)
        .ok_or_else(|| anyhow!("Map project identity is missing"))
}

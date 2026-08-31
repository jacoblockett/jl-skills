fn generate_id(graph: &Graph) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    loop {
        let id: String = (0..20)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect();
        if !graph.nodes.contains_key(&id)
            && !graph
                .replacements
                .iter()
                .any(|replacement| replacement.old_id == id || replacement.new_id == id)
        {
            return id;
        }
    }
}

fn normalize_input_id(id: &str) -> String {
    id.strip_prefix("node:").unwrap_or(id).to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn parse_bool(value: &str) -> Result<bool> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => bail!("expected true or false"),
    }
}

fn parse_depth(value: &str) -> Result<Depth> {
    match value {
        "mvp" => Ok(Depth::Mvp),
        "thorough" => Ok(Depth::Thorough),
        _ => bail!("depth must be mvp or thorough"),
    }
}

fn parse_optional_depth(value: &str) -> Result<Option<Depth>> {
    if value == "null" {
        Ok(None)
    } else {
        parse_depth(value).map(Some)
    }
}

fn parse_stance(value: &str) -> Result<Stance> {
    match value {
        "normal" => Ok(Stance::Normal),
        "adversarial" => Ok(Stance::Adversarial),
        _ => bail!("stance must be normal or adversarial"),
    }
}

fn parse_optional_stance(value: &str) -> Result<Option<Stance>> {
    if value == "null" {
        Ok(None)
    } else {
        parse_stance(value).map(Some)
    }
}

fn parse_keywords(value: &str) -> Result<Vec<String>> {
    let keywords: Vec<String> = serde_json::from_str(value).context("keywords must be a JSON string array")?;
    Ok(keywords)
}

fn normalize_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn normalize_summary(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn emit(value: Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn resolve_existing_map(path: Option<&Path>, config: Option<&Path>) -> Result<PathBuf> {
    let cwd = env::current_dir()?;
    let explicit_config = load_explicit_config(config)?;
    let cwd_config = load_optional_config(&cwd.join(".maprc"))?;

    let selected = if let Some(path) = path {
        expand_tilde(path)
    } else if let Some((config_path, rc)) = &explicit_config {
        if let Some(path) = &rc.path {
            resolve_config_relative(config_path, path)
        } else if let Some((cwd_config_path, cwd_rc)) = &cwd_config {
            if let Some(path) = &cwd_rc.path {
                resolve_config_relative(cwd_config_path, path)
            } else {
                cwd.clone()
            }
        } else {
            cwd.clone()
        }
    } else if let Some((config_path, rc)) = &cwd_config {
        if let Some(path) = &rc.path {
            resolve_config_relative(config_path, path)
        } else {
            cwd.clone()
        }
    } else {
        cwd.clone()
    };

    let map_dir = as_map_dir(&selected);
    if !map_dir.is_dir() {
        bail!("no .map exists at resolved path {}", selected.display());
    }
    Ok(map_dir.canonicalize().unwrap_or(map_dir))
}

fn resolve_init_target(path: Option<&Path>, config: Option<&Path>) -> Result<PathBuf> {
    let cwd = env::current_dir()?;
    let explicit_config = load_explicit_config(config)?;
    let cwd_config = load_optional_config(&cwd.join(".maprc"))?;
    let selected = if let Some(path) = path {
        expand_tilde(path)
    } else if let Some((config_path, rc)) = &explicit_config {
        if let Some(path) = &rc.path {
            resolve_config_relative(config_path, path)
        } else if let Some((cwd_config_path, cwd_rc)) = &cwd_config {
            cwd_rc
                .path
                .as_ref()
                .map(|path| resolve_config_relative(cwd_config_path, path))
                .unwrap_or_else(|| cwd.clone())
        } else {
            cwd.clone()
        }
    } else if let Some((config_path, rc)) = &cwd_config {
        rc.path
            .as_ref()
            .map(|path| resolve_config_relative(config_path, path))
            .unwrap_or_else(|| cwd.clone())
    } else {
        cwd.clone()
    };
    if selected.file_name().and_then(|name| name.to_str()) == Some(".map") {
        let parent = selected.parent().ok_or_else(|| anyhow!("invalid .map path"))?;
        if !parent.is_dir() {
            bail!("Map parent {} does not exist", parent.display());
        }
        Ok(selected)
    } else {
        if !selected.is_dir() {
            bail!("Map root {} does not exist", selected.display());
        }
        Ok(selected.join(".map"))
    }
}

fn resolve_schema(schema: Option<&Path>, config: Option<&Path>) -> Result<PathBuf> {
    let cwd = env::current_dir()?;
    if let Some(schema) = schema {
        let path = expand_tilde(schema);
        if !path.is_file() {
            bail!("schema {} does not exist", path.display());
        }
        return Ok(path);
    }
    if let Some((config_path, rc)) = load_explicit_config(config)? {
        if let Some(schema) = rc.schema {
            let path = resolve_config_relative(&config_path, &schema);
            if !path.is_file() {
                bail!("schema {} from explicit config does not exist", path.display());
            }
            return Ok(path);
        }
    }
    if let Some((config_path, rc)) = load_optional_config(&cwd.join(".maprc"))? {
        if let Some(schema) = rc.schema {
            let path = resolve_config_relative(&config_path, &schema);
            if !path.is_file() {
                bail!("schema {} from cwd config does not exist", path.display());
            }
            return Ok(path);
        }
    }
    let executable = env::current_exe().context("resolving Map runtime executable")?;
    let runtime_root = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| anyhow!("cannot determine Map runtime root from {}", executable.display()))?;
    let path = runtime_root.join("schema.surql");
    if !path.is_file() {
        bail!(
            "default schema {} does not exist; supply --schema or configure schema in .maprc",
            path.display()
        );
    }
    Ok(path)
}

fn load_explicit_config(path: Option<&Path>) -> Result<Option<(PathBuf, MapRc)>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let expanded = expand_tilde(path);
    let file = if expanded.is_dir() {
        expanded.join(".maprc")
    } else {
        expanded
    };
    if !file.is_file() {
        bail!("explicit config {} does not exist", file.display());
    }
    load_optional_config(&file)
}

fn load_optional_config(path: &Path) -> Result<Option<(PathBuf, MapRc)>> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        bail!("config {} is not a file", path.display());
    }
    let content = fs::read_to_string(path)
        .with_context(|| format!("reading config {}", path.display()))?;
    let config: MapRc = toml::from_str(&content)
        .with_context(|| format!("parsing config {}", path.display()))?;
    Ok(Some((path.to_path_buf(), config)))
}

fn resolve_config_relative(config_path: &Path, value: &Path) -> PathBuf {
    let expanded = expand_tilde(value);
    if expanded.is_absolute() {
        expanded
    } else {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(expanded)
    }
}

fn as_map_dir(path: &Path) -> PathBuf {
    if path.file_name().and_then(|name| name.to_str()) == Some(".map") {
        path.to_path_buf()
    } else {
        path.join(".map")
    }
}

fn expand_tilde(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if text == "~" {
        return home_dir().unwrap_or_else(|_| path.to_path_buf());
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        if let Ok(home) = home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

fn home_dir() -> Result<PathBuf> {
    if let Some(value) = env::var_os("USERPROFILE") {
        return Ok(PathBuf::from(value));
    }
    if let Some(value) = env::var_os("HOME") {
        return Ok(PathBuf::from(value));
    }
    bail!("cannot determine user home directory")
}

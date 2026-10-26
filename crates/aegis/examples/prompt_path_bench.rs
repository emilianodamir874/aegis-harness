//! Mide el trabajo de filesystem que el harness repite por inferencia.
//!
//! `cargo run -p aegis --example prompt_path_bench --release -- <working_dir> [iteraciones]`
//!
//! Los cuatro caminos que toca cada request: armar el system prompt (hints globales + locales),
//! el tracker de hints de subdirectorio (una pasada por cada directorio que tocaron las tools) y
//! el descubrimiento de skills. Imprime promedio y total por camino.

use std::path::{Path, PathBuf};
use std::time::Instant;

use aegis::agents::PromptManager;
use aegis::config::AegisMode;
use aegis::hints::{
    build_gitignore, get_context_filenames, load_hint_files, SubdirectoryHintTracker,
};
use aegis::session::Session;

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(
        args.next()
            .unwrap_or_else(|| r"C:\Aegis-Proyects".to_string()),
    );
    let iterations: usize = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);

    if !root.is_dir() {
        eprintln!("no es un directorio: {}", root.display());
        std::process::exit(2);
    }

    // Un directorio del repo con AGENTS.md propio y varios ancestros con hints.
    let nested = find_nested_dir(&root).unwrap_or_else(|| root.clone());

    println!("working_dir: {}", root.display());
    println!("subdir:      {}", nested.display());
    println!("iteraciones: {iterations}\n");

    let hints_filenames = get_context_filenames();
    let gitignore = build_gitignore(&root);
    let hints = load_hint_files(&root, &hints_filenames, &gitignore);
    println!("hints del working_dir: {} bytes\n", hints.len());

    let session = Session {
        working_dir: root.clone(),
        ..Session::default()
    };

    report("build_system_prompt", iterations, || {
        let prompt = PromptManager::new().build_system_prompt(&session, Vec::new(), AegisMode::Auto);
        prompt.len()
    });

    report("build_gitignore", iterations, || build_gitignore(&root).num_whitelists() as usize);

    report("load_hint_files", iterations, || {
        load_hint_files(&root, &hints_filenames, &gitignore).len()
    });

    let tool_args: Vec<Option<serde_json::Map<String, serde_json::Value>>> = (0..10)
        .map(|index| {
            let path = format!("{}/src/crates/aegis-{index}/src/lib.rs", nested.display());
            let mut map = serde_json::Map::new();
            map.insert("path".to_string(), serde_json::Value::String(path));
            Some(map)
        })
        .collect();

    report("subdir_hint_tracker(10 dirs)", iterations, || {
        let mut tracker = SubdirectoryHintTracker::new();
        for arguments in &tool_args {
            tracker.record_tool_arguments(arguments, &root);
        }
        tracker.load_new_hints(&root).len()
    });

    let skill_iterations = iterations.max(10) / 5;
    report("discover_skills", skill_iterations, || {
        aegis::skills::discover_skills(Some(&root)).len()
    });
}

fn find_nested_dir(root: &Path) -> Option<PathBuf> {
    let candidate = root.join("src").join("crates").join("aegis").join("src");
    candidate.is_dir().then_some(candidate)
}

fn report(label: &str, iterations: usize, mut run: impl FnMut() -> usize) {
    // Una pasada en frio fuera de la medicion, para no cargar el arranque del proceso.
    let _ = run();
    let started = Instant::now();
    let mut checksum = 0usize;
    for _ in 0..iterations {
        checksum = checksum.wrapping_add(run());
    }
    let elapsed = started.elapsed();
    let per_call = elapsed.as_secs_f64() * 1000.0 / iterations as f64;
    println!(
        "{label:<32} {per_call:>8.3} ms/llamada  total {:>8.1} ms  ({iterations} llamadas, checksum {checksum})",
        elapsed.as_secs_f64() * 1000.0
    );
}

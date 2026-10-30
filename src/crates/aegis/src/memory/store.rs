//! Store de la memoria del operador.
//!
//! Un solo archivo, `state/data/memory/facts.jsonl`, una linea por hecho, con estado, procedencia
//! y evidencia. El archivo es la fuente; el digest que entra al prompt es una vista acotada.
//!
//! Reglas que sostienen esto:
//!
//! - **Nada se borra sin rastro.** `forget` marca `rejected`; el hecho sigue en el archivo con su
//!   evidencia. Solo una persona puede vaciarlo a mano.
//! - **Confirmado no es lo mismo que inferido.** Un hecho `inferred` nace `candidate` con confianza
//!   máxima 0,6 y no entra al digest hasta que se repite (dos evidencias) o alguien lo confirma.
//! - **La escritura es atomica y ordenada.** Se escribe a `.tmp` y se renombra, con las filas
//!   ordenadas por id: la misma entrada produce los mismos bytes, que es lo que hace idempotente a
//!   la consolidacion.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::config::paths::Paths;

/// Techo de confianza para lo que escribe el extractor. Un hecho inferido no puede competir con una
/// declaracion explicita del operador.
pub const CANDIDATE_CONFIDENCE_CEILING: f32 = 0.6;

/// Un hecho confirmado sin uso en este plazo (y sin pin) pasa a `stale`. No se borra.
pub const STALE_AFTER_DAYS: i64 = 90;

/// Lo que entra al prompt por turno. Si crece, la memoria deja de ser memoria y pasa a ser impuesto.
pub const DIGEST_MAX_CHARS: usize = 4_000;
pub const DIGEST_MAX_FACTS: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Candidate,
    #[default]
    Confirmed,
    Rejected,
    Stale,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Candidate => "candidate",
            Status::Confirmed => "confirmed",
            Status::Rejected => "rejected",
            Status::Stale => "stale",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Lo dijo el operador, o el agente lo guardo con `memory_write`.
    #[default]
    Declared,
    /// Lo propuso el extractor al cierre de un turno.
    Inferred,
    /// Vino de otro lado (proyeccion, importacion).
    Imported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fact {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub source: Source,
    /// `"<session_id>: <cita corta>"` por cada vez que el hecho se observo.
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub last_seen: String,
    #[serde(default)]
    pub session: String,
}

fn default_confidence() -> f32 {
    0.8
}

impl Fact {
    /// ¿Este hecho se le puede mostrar al modelo como cierto?
    pub fn is_digest_eligible(&self) -> bool {
        match self.status {
            Status::Confirmed => true,
            Status::Candidate => self.confidence >= 0.85,
            Status::Rejected | Status::Stale => false,
        }
    }

    fn touch(&mut self, now: &str) {
        self.updated = now.to_string();
        self.last_seen = now.to_string();
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ConsolidationReport {
    pub total: usize,
    pub confirmed: usize,
    pub candidates: usize,
    pub stale: usize,
    pub rejected: usize,
    pub duplicates_merged: usize,
    pub promoted: Vec<String>,
    pub marked_stale: Vec<String>,
    pub changed: bool,
}

#[derive(Debug)]
pub struct UpsertOutcome {
    pub id: String,
    pub created: bool,
}

pub fn store_path() -> PathBuf {
    Paths::in_data_dir("memory").join("facts.jsonl")
}

pub fn report_path() -> PathBuf {
    Paths::in_data_dir("memory").join("memory-report.md")
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Normalizacion usada para decidir si dos hechos son el mismo: minusculas, solo alfanumericos y
/// espacios simples. "Prefiere swaps inmediatos." y "prefiere swaps inmediatos" son la misma fila.
pub fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(fold_accent)
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Pliega los acentos del espanol y del portugues para que "espanol" y "español" sean el mismo
/// hecho. Sin esto, el extractor y el operador escriben la misma frase dos veces.
fn fold_accent(c: char) -> char {
    match c {
        'a' => 'a',
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        other => other,
    }
}

pub fn read_from(path: &Path) -> Vec<Fact> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Fact>(line).ok())
        .collect()
}

/// Escribe el archivo completo: ordenado por id y con las lineas canonicas de serde. Dos escrituras
/// del mismo contenido dan bytes identicos, que es lo que se usa para probar idempotencia.
pub fn write_to(path: &Path, facts: &[Fact]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut sorted: Vec<&Fact> = facts.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));

    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        for fact in &sorted {
            let line = serde_json::to_string(fact)?;
            writeln!(file, "{line}")?;
        }
        file.flush()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn next_id(facts: &[Fact]) -> String {
    let max = facts
        .iter()
        .filter_map(|f| f.id.strip_prefix("F-"))
        .filter_map(|n| n.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    format!("F-{:04}", max + 1)
}

/// Alta o actualizacion de un hecho declarado (la tool `memory_write`).
pub fn upsert_declared(
    path: &Path,
    session_id: &str,
    text: &str,
    kind: &str,
    tags: Vec<String>,
    confidence: f32,
    pinned: bool,
) -> Result<UpsertOutcome> {
    let mut facts = read_from(path);
    let key = normalize(text);
    let now = now_iso();

    if let Some(existing) = facts.iter_mut().find(|f| normalize(&f.text) == key) {
        existing.touch(&now);
        existing.confidence = confidence.clamp(0.0, 1.0);
        existing.pinned = existing.pinned || pinned;
        // Declararlo otra vez es una segunda evidencia y lo devuelve a `confirmed`.
        existing.status = Status::Confirmed;
        existing.source = Source::Declared;
        if !kind.is_empty() {
            existing.kind = kind.to_string();
        }
        for tag in tags {
            if !existing.tags.contains(&tag) {
                existing.tags.push(tag);
            }
        }
        let evidence = format!("{session_id}: declarado");
        if !existing.evidence.contains(&evidence) {
            existing.evidence.push(evidence);
        }
        let id = existing.id.clone();
        write_to(path, &facts)?;
        return Ok(UpsertOutcome { id, created: false });
    }

    let id = next_id(&facts);
    facts.push(Fact {
        id: id.clone(),
        text: text.trim().to_string(),
        kind: kind.to_string(),
        tags,
        confidence: confidence.clamp(0.0, 1.0),
        pinned,
        status: Status::Confirmed,
        source: Source::Declared,
        evidence: vec![format!("{session_id}: declarado")],
        created: now.clone(),
        updated: now.clone(),
        last_seen: now,
        session: session_id.to_string(),
    });
    write_to(path, &facts)?;
    Ok(UpsertOutcome { id, created: true })
}

/// Alta de un hecho inferido por el extractor. Nunca pisa un hecho confirmado: si el texto ya
/// existe, solo suma evidencia y sube la confianza hasta el techo de candidato.
pub fn append_candidate(
    path: &Path,
    session_id: &str,
    text: &str,
    kind: &str,
    confidence: f32,
    quote: &str,
) -> Result<Option<UpsertOutcome>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let mut facts = read_from(path);
    let key = normalize(text);
    let now = now_iso();
    let evidence = format!("{session_id}: {}", truncate_chars(quote.trim(), 160));
    let capped = confidence.clamp(0.0, CANDIDATE_CONFIDENCE_CEILING);

    if let Some(existing) = facts.iter_mut().find(|f| normalize(&f.text) == key) {
        if existing.status == Status::Rejected {
            return Ok(None);
        }
        if !existing.evidence.contains(&evidence) {
            existing.evidence.push(evidence);
        }
        existing.last_seen = now.clone();
        if existing.source == Source::Inferred {
            // Segunda observacion: suma confianza sin pasar el techo de candidato.
            existing.confidence = (existing.confidence + 0.1).min(CANDIDATE_CONFIDENCE_CEILING);
            existing.updated = now;
        }
        let id = existing.id.clone();
        write_to(path, &facts)?;
        return Ok(Some(UpsertOutcome { id, created: false }));
    }

    let id = next_id(&facts);
    facts.push(Fact {
        id: id.clone(),
        text: text.to_string(),
        kind: kind.to_string(),
        tags: Vec::new(),
        confidence: capped,
        pinned: false,
        status: Status::Candidate,
        source: Source::Inferred,
        evidence: vec![evidence],
        created: now.clone(),
        updated: now.clone(),
        last_seen: now,
        session: session_id.to_string(),
    });
    write_to(path, &facts)?;
    Ok(Some(UpsertOutcome { id, created: true }))
}

/// Baja logica: el hecho queda en el archivo como `rejected`, con su evidencia intacta.
pub fn reject(path: &Path, id: &str) -> Result<bool> {
    let mut facts = read_from(path);
    let now = now_iso();
    let Some(fact) = facts.iter_mut().find(|f| f.id == id) else {
        return Ok(false);
    };
    fact.status = Status::Rejected;
    fact.updated = now;
    write_to(path, &facts)?;
    Ok(true)
}

/// Confirmacion explicita (panel de la UI o `memory_confirm`).
pub fn confirm(path: &Path, id: &str) -> Result<bool> {
    let mut facts = read_from(path);
    let now = now_iso();
    let Some(fact) = facts.iter_mut().find(|f| f.id == id) else {
        return Ok(false);
    };
    fact.status = Status::Confirmed;
    fact.updated = now;
    write_to(path, &facts)?;
    Ok(true)
}

/// Pasa a `confirmed` los candidatos con dos evidencias independientes (o con pin).
fn promote_candidates(facts: &mut [Fact], now: &str, promoted: &mut Vec<String>) {
    for fact in facts.iter_mut() {
        if fact.status != Status::Candidate {
            continue;
        }
        let independent: usize = fact
            .evidence
            .iter()
            .filter_map(|e| e.split(':').next())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        if independent >= 2 || fact.pinned {
            fact.status = Status::Confirmed;
            fact.confidence = fact.confidence.max(0.7);
            fact.updated = now.to_string();
            promoted.push(fact.id.clone());
        }
    }
}

fn mark_stale(facts: &mut [Fact], now: &str, stale: &mut Vec<String>) {
    let Some(now_dt) = chrono::DateTime::parse_from_rfc3339(now)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc))
    else {
        return;
    };
    for fact in facts.iter_mut() {
        if fact.pinned || fact.status != Status::Confirmed || fact.confidence >= 0.9 {
            continue;
        }
        let stamp = if fact.last_seen.is_empty() {
            &fact.updated
        } else {
            &fact.last_seen
        };
        let Some(seen) = chrono::DateTime::parse_from_rfc3339(stamp)
            .ok()
            .map(|dt| dt.with_timezone(&chrono::Utc))
        else {
            continue;
        };
        if (now_dt - seen).num_days() >= STALE_AFTER_DAYS {
            fact.status = Status::Stale;
            fact.updated = now.to_string();
            stale.push(fact.id.clone());
        }
    }
}

/// Fusiona hechos con el mismo texto normalizado: se queda con el id mas bajo, junta etiquetas y
/// evidencia, toma la confianza mas alta y el estado mas fuerte.
fn merge_duplicates(facts: &mut Vec<Fact>) -> usize {
    let mut groups: BTreeMap<String, Vec<Fact>> = BTreeMap::new();
    for fact in facts.drain(..) {
        groups.entry(normalize(&fact.text)).or_default().push(fact);
    }
    let mut merged = 0usize;
    let mut out: Vec<Fact> = Vec::new();
    for (_, mut group) in groups {
        if group.len() == 1 {
            out.push(group.remove(0));
            continue;
        }
        merged += group.len() - 1;
        group.sort_by(|a, b| a.id.cmp(&b.id));
        let mut keeper = group.remove(0);
        for other in group {
            keeper.confidence = keeper.confidence.max(other.confidence);
            keeper.pinned = keeper.pinned || other.pinned;
            if other.status == Status::Confirmed {
                keeper.status = Status::Confirmed;
                keeper.source = other.source;
            }
            for tag in other.tags {
                if !keeper.tags.contains(&tag) {
                    keeper.tags.push(tag);
                }
            }
            for evidence in other.evidence {
                if !keeper.evidence.contains(&evidence) {
                    keeper.evidence.push(evidence);
                }
            }
            if other.updated > keeper.updated {
                keeper.updated = other.updated;
            }
            if other.last_seen > keeper.last_seen {
                keeper.last_seen = other.last_seen;
            }
            if keeper.kind.is_empty() {
                keeper.kind = other.kind;
            }
        }
        out.push(keeper);
    }
    *facts = out;
    merged
}

/// Pasada de consolidacion. Determinista: correrla dos veces sobre el mismo archivo deja los mismos
/// bytes (segunda corrida: `changed = false`).
pub fn consolidate(path: &Path) -> Result<ConsolidationReport> {
    let now = now_iso();
    let mut facts = read_from(path);
    let before = serde_json::to_string(&{
        let mut copy = facts.clone();
        copy.sort_by(|a, b| a.id.cmp(&b.id));
        copy
    })?;

    let duplicates_merged = merge_duplicates(&mut facts);
    let mut promoted = Vec::new();
    promote_candidates(&mut facts, &now, &mut promoted);
    let mut marked_stale = Vec::new();
    mark_stale(&mut facts, &now, &mut marked_stale);

    facts.sort_by(|a, b| a.id.cmp(&b.id));
    let after = serde_json::to_string(&facts)?;
    let changed = before != after;
    if changed {
        write_to(path, &facts)?;
    }

    let report = ConsolidationReport {
        total: facts.len(),
        confirmed: facts
            .iter()
            .filter(|f| f.status == Status::Confirmed)
            .count(),
        candidates: facts
            .iter()
            .filter(|f| f.status == Status::Candidate)
            .count(),
        stale: facts.iter().filter(|f| f.status == Status::Stale).count(),
        rejected: facts
            .iter()
            .filter(|f| f.status == Status::Rejected)
            .count(),
        duplicates_merged,
        promoted,
        marked_stale,
        changed,
    };
    write_report(&report)?;
    Ok(report)
}

pub fn write_report(report: &ConsolidationReport) -> Result<()> {
    let path = report_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut body = String::new();
    body.push_str("# Memoria del operador - consolidacion\n\n");
    body.push_str(&format!("Generado: {}\n\n", now_iso()));
    body.push_str(&format!(
        "| total | confirmados | candidatos | stale | rechazados |\n|---|---|---|---|---|\n| {} | {} | {} | {} | {} |\n\n",
        report.total, report.confirmed, report.candidates, report.stale, report.rejected
    ));
    body.push_str(&format!(
        "- Duplicados fusionados: {}\n- Promovidos a confirmado: {}\n- Marcados stale: {}\n- Cambios en esta corrida: {}\n",
        report.duplicates_merged,
        if report.promoted.is_empty() { "-".to_string() } else { report.promoted.join(", ") },
        if report.marked_stale.is_empty() { "-".to_string() } else { report.marked_stale.join(", ") },
        if report.changed { "si" } else { "no (idempotente)" },
    ));
    std::fs::write(&path, body)?;
    Ok(())
}

/// Busca por palabras: todas las palabras tienen que aparecer en texto, categoria o etiquetas.
pub fn search(facts: &[Fact], query: &str, limit: usize) -> Vec<Fact> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    facts
        .iter()
        .filter(|f| f.status != Status::Rejected)
        .filter(|f| {
            let haystack = format!(
                "{} {} {}",
                f.text.to_lowercase(),
                f.kind.to_lowercase(),
                f.tags.join(" ").to_lowercase()
            );
            terms.iter().all(|term| haystack.contains(term))
        })
        .take(limit)
        .cloned()
        .collect()
}

/// Digest por turno: pinneados primero, despues lo visto mas recientemente. Los candidatos solo
/// entran si llegaron a alta confianza y se marcan como tales.
pub fn digest(facts: &[Fact]) -> Option<String> {
    let mut eligible: Vec<&Fact> = facts.iter().filter(|f| f.is_digest_eligible()).collect();
    if eligible.is_empty() {
        return None;
    }
    eligible.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.last_seen.cmp(&a.last_seen))
    });

    let mut selected = Vec::new();
    let mut used = 0usize;
    for fact in eligible.into_iter().take(DIGEST_MAX_FACTS) {
        let cost = fact.text.chars().count() + 16;
        if used + cost > DIGEST_MAX_CHARS {
            break;
        }
        used += cost;
        selected.push(fact.clone());
    }
    if selected.is_empty() {
        return None;
    }

    let body = selected
        .iter()
        .map(|f| {
            let mut line = format!("- [{}] {}", f.id, f.text);
            if f.status == Status::Candidate {
                line.push_str(" (candidato, sin confirmar)");
            } else if !f.kind.is_empty() {
                line.push_str(&format!(" ({}, conf {:.2})", f.kind, f.confidence));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n");

    Some(format!("## Memoria del operador\n\n{body}\n"))
}

/// Linea para listados, con estado y evidencia resumida.
pub fn render_line(fact: &Fact) -> String {
    let mut line = format!("- [{}] {}", fact.id, fact.text);
    let mut meta = Vec::new();
    if !fact.kind.is_empty() {
        meta.push(fact.kind.clone());
    }
    meta.push(format!("conf {:.2}", fact.confidence));
    meta.push(fact.status.as_str().to_string());
    if fact.pinned {
        meta.push("pinned".to_string());
    }
    if fact.status == Status::Candidate && !fact.evidence.is_empty() {
        meta.push(format!("evidencia {}", fact.evidence.len()));
    }
    line.push_str(&format!(" ({})", meta.join(", ")));
    line
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn path_in(dir: &TempDir) -> PathBuf {
        dir.path().join("facts.jsonl")
    }

    #[test]
    fn legacy_rows_load_as_confirmed_declared() {
        let dir = TempDir::new().unwrap();
        let path = path_in(&dir);
        std::fs::write(
            &path,
            r#"{"id":"F-0001","text":"Prefiere respuestas directas","kind":"style","confidence":0.95,"pinned":true}"#,
        )
        .unwrap();
        let facts = read_from(&path);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].status, Status::Confirmed);
        assert_eq!(facts[0].source, Source::Declared);
        assert!(facts[0].is_digest_eligible());
    }

    #[test]
    fn candidates_are_capped_and_need_two_sessions_to_promote() {
        let dir = TempDir::new().unwrap();
        let path = path_in(&dir);
        append_candidate(
            &path,
            "s1",
            "Prefiere tablas, no prosa",
            "style",
            0.95,
            "dame la tabla",
        )
        .unwrap();
        let facts = read_from(&path);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].status, Status::Candidate);
        assert!(facts[0].confidence <= CANDIDATE_CONFIDENCE_CEILING);
        assert!(!facts[0].is_digest_eligible());

        let report = consolidate(&path).unwrap();
        assert!(!report.changed, "una sola evidencia no promueve");

        append_candidate(
            &path,
            "s2",
            "Prefiere tablas, no prosa",
            "style",
            0.5,
            "otra vez tablas",
        )
        .unwrap();
        let report = consolidate(&path).unwrap();
        assert_eq!(report.promoted, vec!["F-0001".to_string()]);
        assert_eq!(read_from(&path)[0].status, Status::Confirmed);
    }

    #[test]
    fn consolidate_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let path = path_in(&dir);
        upsert_declared(
            &path,
            "s1",
            "Prefiere swaps inmediatos",
            "preference",
            vec![],
            0.9,
            true,
        )
        .unwrap();
        append_candidate(&path, "s1", "Trabaja solo", "fact", 0.5, "trabajo solo").unwrap();
        append_candidate(&path, "s2", "Trabaja solo", "fact", 0.5, "siempre solo").unwrap();

        consolidate(&path).unwrap();
        let bytes_after_first = std::fs::read(&path).unwrap();
        let second = consolidate(&path).unwrap();
        let bytes_after_second = std::fs::read(&path).unwrap();
        assert_eq!(bytes_after_first, bytes_after_second);
        assert!(!second.changed);
        assert_eq!(
            second.confirmed + second.candidates + second.stale + second.rejected,
            second.total
        );
    }

    #[test]
    fn duplicates_merge_into_the_lowest_id_and_keep_evidence() {
        let dir = TempDir::new().unwrap();
        let path = path_in(&dir);
        upsert_declared(&path, "s1", "Usa Windows 11", "fact", vec![], 0.8, false).unwrap();
        let mut facts = read_from(&path);
        let mut copy = facts[0].clone();
        copy.id = "F-0009".to_string();
        copy.text = "usa windows 11.".to_string();
        copy.evidence.push("s2: repetido".to_string());
        facts.push(copy);
        write_to(&path, &facts).unwrap();
        assert_eq!(read_from(&path).len(), 2);

        let report = consolidate(&path).unwrap();
        assert_eq!(report.duplicates_merged, 1);
        let merged = read_from(&path);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, "F-0001");
        assert!(merged[0].evidence.len() >= 2);
    }

    #[test]
    fn forget_is_a_soft_delete_and_leaves_the_row() {
        let dir = TempDir::new().unwrap();
        let path = path_in(&dir);
        let out = upsert_declared(&path, "s1", "Dato viejo", "fact", vec![], 0.7, false).unwrap();
        assert!(reject(&path, &out.id).unwrap());
        let facts = read_from(&path);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].status, Status::Rejected);
        assert!(!facts[0].is_digest_eligible());
        assert!(search(&facts, "viejo", 10).is_empty());
    }

    #[test]
    fn digest_puts_pinned_first_and_skips_candidates() {
        let dir = TempDir::new().unwrap();
        let path = path_in(&dir);
        upsert_declared(&path, "s1", "Regla fija", "preference", vec![], 0.95, true).unwrap();
        upsert_declared(&path, "s1", "Dato suelto", "fact", vec![], 0.8, false).unwrap();
        append_candidate(&path, "s1", "Algo inferido", "fact", 0.5, "quote").unwrap();
        let text = digest(&read_from(&path)).unwrap();
        assert!(text.starts_with("## Memoria del operador"));
        assert!(text.contains("Regla fija"));
        assert!(text.contains("Dato suelto"));
        assert!(!text.contains("Algo inferido"));
        assert!(text.find("Regla fija").unwrap() < text.find("Dato suelto").unwrap());
    }

    #[test]
    fn declared_write_after_candidate_confirms_it() {
        let dir = TempDir::new().unwrap();
        let path = path_in(&dir);
        append_candidate(&path, "s1", "Prefiere LF", "style", 0.5, "sin CRLF").unwrap();
        upsert_declared(&path, "s2", "prefiere lf", "style", vec![], 0.9, false).unwrap();
        let facts = read_from(&path);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].status, Status::Confirmed);
        assert_eq!(facts[0].confidence, 0.9);
    }
}

//! Registro de workspaces del operador.
//!
//! Un workspace es una raíz de trabajo en disco (`C:\Aegis-Proyects`, `C:\Users\Emiliano\Documents\ROLEPLAY AI`, ...)
//! con identidad estable, nombre para la UI, fila fijable y defaults por workspace. Vive en el
//! store (`sessions.db`), no en `web/config.json`: es estado del operador, con historial y
//! último uso, y tiene que sobrevivir a otro navegador, al teléfono y a un `rm -rf` del proxy.
//!
//! La identidad (`id`) es el hash corto de la raíz normalizada, así que dos ortografías de la
//! misma carpeta (`\\?\C:\...`, mayúsculas distintas, barra final) colapsan en la misma fila: la
//! PK hace de dedupe, no un `SELECT` previo. `root` queda con la ortografía canónica porque es
//! lo que se muestra y lo que se compara contra `sessions.project_id`.
//!
//! El sembrado inicial agrupa las sesiones existentes por `project_id` (que desde la migración 21
//! vale el `working_dir` canónico) y usa `MAX(updated_at)` como `last_used_at`, para que la lista
//! de recientes arranque ordenada por uso real y no toda en "ahora".

use std::collections::HashSet;

use anyhow::Result;
use sha2::{Digest, Sha256};
use sqlx::{Pool, Sqlite, SqliteConnection};

/// DDL de la tabla. Idempotente: se ejecuta tal cual en `create_schema` (store nuevo) y en la
/// migración 22 (store existente).
pub const CREATE_WORKSPACES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
    id           TEXT PRIMARY KEY,
    root         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    pinned       INTEGER NOT NULL DEFAULT 0,
    defaults     TEXT NOT NULL DEFAULT '{}',
    last_used_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
)
"#;

pub const CREATE_WORKSPACES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_workspaces_last_used ON workspaces(last_used_at DESC)";

/// Una fila de `workspaces`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Workspace {
    pub id: String,
    pub root: String,
    pub name: String,
    pub pinned: i64,
    /// JSON con `provider`, `model`, `mode`, `permissions`, `extensions`.
    pub defaults: String,
    pub last_used_at: Option<String>,
    pub created_at: Option<String>,
}

/// Ortografía normalizada de una raíz, usada sólo para derivar la identidad.
///
/// Minúsculas porque en Windows la comparación de rutas no distingue mayúsculas; sin prefijo
/// verbatim y sin separador final porque son variantes de la misma carpeta. La raíz de unidad
/// (`c:\`) conserva su separador.
fn normalize_root(root: &str) -> String {
    let mut text = root.trim().replace('/', "\\");
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            text = rest.to_string();
        }
    }
    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }
    text.to_lowercase()
}

/// Identidad estable de un workspace: `ws_` + 16 hex de SHA-256 de la raíz normalizada.
pub fn workspace_id(root: &str) -> String {
    let digest = Sha256::digest(normalize_root(root).as_bytes());
    let mut id = String::with_capacity(19);
    id.push_str("ws_");
    for byte in &digest[..8] {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

/// Nombre para la UI: el último componente de la raíz. `C:\` no tiene último componente útil,
/// así que se devuelve la raíz entera.
pub fn workspace_name(root: &str) -> String {
    let trimmed = root.trim_end_matches(['\\', '/']);
    match trimmed.rsplit(['\\', '/']).next() {
        Some(last) if !last.is_empty() => last.to_string(),
        _ => root.to_string(),
    }
}

/// Inserta el workspace o, si ya existe, sólo adelanta `last_used_at`.
///
/// `last_used_at = None` significa "ahora" (alta de sesión). El `CASE` evita retroceder el
/// timestamp cuando el sembrado trae un valor histórico y la fila ya fue tocada hoy.
pub async fn register_workspace(
    conn: &mut SqliteConnection,
    root: &str,
    last_used_at: Option<&str>,
) -> Result<String> {
    let canonical =
        crate::session::session_manager::canonical_working_dir(std::path::PathBuf::from(root));
    let root = canonical.to_string_lossy().to_string();
    let id = workspace_id(&root);
    let name = workspace_name(&root);

    sqlx::query(
        r#"
        INSERT INTO workspaces (id, root, name, pinned, defaults, last_used_at, created_at)
        VALUES (?, ?, ?, 0, '{}', COALESCE(?, datetime('now')), datetime('now'))
        ON CONFLICT DO UPDATE SET
            name = excluded.name,
            last_used_at = CASE
                WHEN workspaces.last_used_at IS NULL THEN excluded.last_used_at
                WHEN excluded.last_used_at IS NULL THEN workspaces.last_used_at
                WHEN excluded.last_used_at > workspaces.last_used_at THEN excluded.last_used_at
                ELSE workspaces.last_used_at
            END
        "#,
    )
    .bind(&id)
    .bind(&root)
    .bind(&name)
    .bind(last_used_at)
    .execute(conn)
    .await?;

    Ok(id)
}

/// Marca uso del workspace en este instante (alta de sesión, cambio de `working_dir`).
pub async fn touch_workspace(conn: &mut SqliteConnection, root: &str) -> Result<String> {
    register_workspace(conn, root, None).await
}

/// Siembra la tabla desde las sesiones existentes. Devuelve cuántas raíces distintas quedaron
/// registradas (no cuántas sesiones se recorrieron).
pub async fn seed_from_sessions(conn: &mut SqliteConnection) -> Result<usize> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT COALESCE(NULLIF(TRIM(project_id), ''), working_dir) AS root,
               MAX(COALESCE(updated_at, created_at)) AS last_used_at
          FROM sessions
         WHERE COALESCE(NULLIF(TRIM(project_id), ''), working_dir) IS NOT NULL
         GROUP BY root
        "#,
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut seen: HashSet<String> = HashSet::new();
    for (root, last_used_at) in rows {
        let id = register_workspace(&mut *conn, &root, last_used_at.as_deref()).await?;
        seen.insert(id);
    }
    Ok(seen.len())
}

/// Lista los workspaces: fijados primero, después por último uso.
pub async fn list_workspaces(pool: &Pool<Sqlite>) -> Result<Vec<Workspace>> {
    let rows = sqlx::query_as::<_, Workspace>(
        r#"
        SELECT id, root, name, pinned, defaults, last_used_at, created_at
          FROM workspaces
         ORDER BY pinned DESC, COALESCE(last_used_at, created_at) DESC, name ASC
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_id_collapses_spellings_of_the_same_root() {
        let plain = workspace_id(r"C:\Aegis-Proyects");
        assert_eq!(plain, workspace_id(r"C:\Aegis-Proyects\"));
        assert_eq!(plain, workspace_id("c:\\aegis-proyects"));
        assert_eq!(plain, workspace_id(r"\\?\C:\Aegis-Proyects"));
        assert_eq!(plain, workspace_id("C:/Aegis-Proyects"));
        assert_eq!(plain.len(), 19);
        assert!(plain.starts_with("ws_"));
        assert_ne!(plain, workspace_id(r"C:\Aegis-Proyects\web"));
    }

    #[test]
    fn root_of_unit_keeps_its_separator() {
        assert_eq!(workspace_id("C:\\"), workspace_id(r"\\?\C:\"));
        assert_eq!(workspace_id("C:\\"), workspace_id("c:/"));
    }

    #[test]
    fn workspace_name_is_the_last_component() {
        assert_eq!(workspace_name(r"C:\Aegis-Proyects"), "Aegis-Proyects");
        assert_eq!(
            workspace_name(r"C:\Users\Emiliano\Documents\ROLEPLAY AI"),
            "ROLEPLAY AI"
        );
        assert_eq!(workspace_name(r"C:\Aegis-Proyects\"), "Aegis-Proyects");
        assert_eq!(workspace_name("C:\\"), "C:");
    }
}

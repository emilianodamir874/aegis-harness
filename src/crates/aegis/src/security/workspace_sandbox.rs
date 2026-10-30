//! Sandbox de escritura por workspace y marcado de comandos destructivos.
//!
//! Dos reglas deterministas, sin modelo de por medio (costo 0 en tokens):
//!
//! 1. **Escritura fuera de la raiz del workspace pide permiso**, aunque `write`/`edit` esten en
//!    `always_allow`. El root es el `working_dir` canonico de la sesion, que desde la tanda 4 tiene
//!    fila en `workspaces`.
//! 2. **Un comando de shell que destruye datos se marca** y pide permiso igual. El marcado no
//!    inspecciona intencion: reconoce formas conocidas (`rm -rf`, `del /f /s /q`, `mkfs`, `DROP
//!    TABLE`, `git reset --hard`, `format`, `diskpart`, ...) y deja el resto pasar.
//!
//! El inspector corre antes que el de permisos y el resultado `RequireApproval` gana sobre un
//! `always_allow`, que es justo lo que hace falta: el sandbox no discute la politica del operador,
//! le agrega una frontera fisica.

use crate::config::AegisMode;
use crate::conversation::message::{Message, ToolRequest};
use crate::session::SessionManager;
use crate::tool_inspection::{InspectionAction, InspectionResult, ToolInspector};
use anyhow::Result;
use async_trait::async_trait;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// Herramientas que escriben archivos.
const WRITE_TOOLS: &[&str] = &["write", "edit"];
/// Herramientas que ejecutan comandos.
const SHELL_TOOLS: &[&str] = &["shell", "bash"];

/// Rutas que se piden aunque esten dentro del root: ahi viven credenciales y el estado del harness.
const PROTECTED_FRAGMENTS: &[&str] = &[
    "\\state\\config\\",
    "/state/config/",
    "\\.ssh\\",
    "/.ssh/",
    "\\.git\\config",
    "/.git/config",
    "secrets.yaml",
    "secrets.yml",
    "auth.json",
];

/// Formas de comando que destruyen datos o el sistema. Se comparan en minusculas sobre el comando
/// completo; no pretenden ser exhaustivas, solo atrapar el error caro.
const DESTRUCTIVE_PATTERNS: &[(&str, &str)] = &[
    ("rm -rf /", "borra el sistema de archivos"),
    ("rm -rf /*", "borra el sistema de archivos"),
    ("rm -rf ~", "borra el home"),
    ("rm -fr /", "borra el sistema de archivos"),
    ("del /f /s /q", "borra recursivamente sin confirmar"),
    ("del /s /q", "borra recursivamente sin confirmar"),
    ("rd /s /q", "borra un arbol de directorios sin confirmar"),
    ("rmdir /s /q", "borra un arbol de directorios sin confirmar"),
    ("format c:", "formatea la unidad del sistema"),
    ("format d:", "formatea una unidad"),
    ("diskpart", "reparticiona discos"),
    ("mkfs.", "formatea un dispositivo"),
    ("dd if=", "escribe bloques crudos"),
    ("shutdown /s", "apaga la maquina"),
    ("shutdown -h", "apaga la maquina"),
    ("git reset --hard", "descarta cambios sin vuelta atras"),
    ("git clean -fdx", "borra archivos no versionados"),
    ("git push --force", "reescribe historia remota"),
    ("drop table", "borra una tabla"),
    ("drop database", "borra una base"),
    ("truncate table", "vacia una tabla"),
    (
        "remove-item -recurse -force",
        "borra recursivamente sin confirmar",
    ),
    ("sdkmanager --uninstall", "desinstala paquetes del SDK"),
    ("docker system prune", "borra imagenes y volumenes"),
    ("docker volume rm", "borra volumenes"),
];

/// Nombre de tool sin el prefijo de extension (`developer__write` -> `write`).
pub fn tool_suffix(name: &str) -> &str {
    name.rsplit("__").next().unwrap_or(name)
}

/// Ruta destino de un `write`/`edit`, si el pedido la trae.
pub fn write_target(
    arguments: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    let arguments = arguments?;
    for key in ["path", "file_path", "filePath"] {
        if let Some(value) = arguments.get(key).and_then(|v| v.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Comando de un `shell`, si el pedido lo trae.
pub fn shell_command(
    arguments: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    arguments?
        .get("command")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// ¿La ruta cae dentro de la raiz? Compara componentes ya resueltos y, en Windows, sin distinguir
/// mayusculas. No sigue symlinks: `canonicalize` se hizo antes, sobre lo que existe.
pub fn path_inside(root: &Path, target: &Path) -> bool {
    let root_components: Vec<String> = component_keys(root);
    let target_components: Vec<String> = component_keys(target);
    if root_components.len() > target_components.len() {
        return false;
    }
    root_components
        .iter()
        .zip(target_components.iter())
        .all(|(a, b)| a == b)
}

fn component_keys(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().to_lowercase()),
            Component::RootDir => Some("\\".to_string()),
            Component::Normal(name) => Some(name.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect()
}

/// Resuelve el destino lo mejor posible: si el archivo no existe, canonicaliza el padre y le pega
/// el nombre; si tampoco existe el padre, cae a una normalizacion lexica de `..` y `.`.
pub fn resolve_target(root: &Path, raw: &str) -> PathBuf {
    let candidate = PathBuf::from(raw);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    if let Ok(resolved) = absolute.canonicalize() {
        return strip_verbatim(resolved);
    }
    if let (Some(parent), Some(name)) = (absolute.parent(), absolute.file_name()) {
        if let Ok(resolved) = parent.canonicalize() {
            return strip_verbatim(resolved).join(name);
        }
    }
    strip_verbatim(lexical_normalize(&absolute))
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return PathBuf::from(rest);
        }
    }
    path
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Veredicto del sandbox para una escritura. `reason` vacio = permitida.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteVerdict {
    pub allowed: bool,
    pub reason: String,
}

pub fn check_write(root: &Path, raw_target: &str) -> WriteVerdict {
    let target = resolve_target(root, raw_target);
    let target_text = target.to_string_lossy().to_lowercase();

    if let Some(hit) = PROTECTED_FRAGMENTS
        .iter()
        .find(|fragment| target_text.contains(&fragment.to_lowercase()))
    {
        return WriteVerdict {
            allowed: false,
            reason: format!(
                "La ruta '{raw_target}' cae en un area protegida ({hit}). Confirmala a mano."
            ),
        };
    }

    if path_inside(root, &target) {
        return WriteVerdict {
            allowed: true,
            reason: String::new(),
        };
    }

    WriteVerdict {
        allowed: false,
        reason: format!(
            "La ruta '{raw_target}' esta fuera del workspace {} (queda en {}). Se pide permiso antes de escribir.",
            root.display(),
            target.display()
        ),
    }
}

/// Motivo por el que un comando se considera destructivo, si lo es.
pub fn destructive_reason(command: &str) -> Option<&'static str> {
    let lowered = command.to_lowercase();
    DESTRUCTIVE_PATTERNS
        .iter()
        .find(|(pattern, _)| lowered.contains(pattern))
        .map(|(_, reason)| *reason)
}

pub struct WorkspaceSandboxInspector {
    session_manager: Arc<SessionManager>,
}

impl WorkspaceSandboxInspector {
    pub fn new(session_manager: Arc<SessionManager>) -> Self {
        Self { session_manager }
    }

    fn verdict(request: &ToolRequest, root: Option<&Path>) -> Option<(InspectionAction, String)> {
        let call = request.tool_call.as_ref().ok()?;
        let tool = tool_suffix(&call.name);

        if WRITE_TOOLS.contains(&tool) {
            let target = write_target(call.arguments.as_ref())?;
            let Some(root) = root else {
                return Some((
                    InspectionAction::RequireApproval(Some(format!(
                        "No pude resolver el workspace de la sesion para '{target}'. Confirma la escritura."
                    ))),
                    "workspace desconocido".to_string(),
                ));
            };
            let verdict = check_write(root, &target);
            if verdict.allowed {
                return None;
            }
            return Some((
                InspectionAction::RequireApproval(Some(verdict.reason.clone())),
                verdict.reason,
            ));
        }

        if SHELL_TOOLS.contains(&tool) {
            let command = shell_command(call.arguments.as_ref())?;
            let reason = destructive_reason(&command)?;
            return Some((
                InspectionAction::RequireApproval(Some(format!(
                    "Comando destructivo: {reason}.\n\n$ {command}"
                ))),
                reason.to_string(),
            ));
        }

        None
    }
}

#[async_trait]
impl ToolInspector for WorkspaceSandboxInspector {
    fn name(&self) -> &'static str {
        "workspace_sandbox"
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn inspect(
        &self,
        session_id: &str,
        tool_requests: &[ToolRequest],
        _messages: &[Message],
        _aegis_mode: AegisMode,
    ) -> Result<Vec<InspectionResult>> {
        let root = self
            .session_manager
            .get_session(session_id, false)
            .await
            .ok()
            .map(|session| session.working_dir);
        let root = root.as_deref().map(|path| path.to_path_buf());
        let root = root.as_deref();

        let mut results = Vec::new();
        for request in tool_requests {
            match Self::verdict(request, root) {
                Some((action, reason)) => results.push(InspectionResult {
                    tool_request_id: request.id.clone(),
                    action,
                    reason,
                    confidence: 0.9,
                    inspector_name: self.name().to_string(),
                    finding_id: Some(format!("sandbox:{}", request.id)),
                }),
                None => results.push(InspectionResult {
                    tool_request_id: request.id.clone(),
                    action: InspectionAction::Allow,
                    reason: "dentro del workspace".to_string(),
                    confidence: 0.9,
                    inspector_name: self.name().to_string(),
                    finding_id: None,
                }),
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from(r"C:\Aegis-Proyects")
    }

    #[test]
    fn inside_the_root_is_allowed() {
        let verdict = check_write(&root(), r"C:\Aegis-Proyects\docs\guia.md");
        assert!(verdict.allowed, "{}", verdict.reason);
        let verdict = check_write(&root(), r"docs\guia.md");
        assert!(verdict.allowed, "{}", verdict.reason);
    }

    #[test]
    fn relative_escape_is_caught() {
        let verdict = check_write(&root(), r"..\otro-proyecto\main.rs");
        assert!(!verdict.allowed);
        assert!(verdict.reason.contains("fuera del workspace"));
    }

    #[test]
    fn sibling_project_is_outside() {
        let verdict = check_write(&root(), r"C:\Users\Emiliano\Documents\ROLEPLAY AI\x.md");
        assert!(!verdict.allowed);
    }

    #[test]
    fn case_and_separator_do_not_fool_the_boundary() {
        assert!(path_inside(
            &root(),
            &PathBuf::from(r"c:/aegis-proyects/src/lib.rs")
        ));
        assert!(!path_inside(
            &root(),
            &PathBuf::from(r"c:/aegis-proyects-otro/src/lib.rs")
        ));
    }

    #[test]
    fn protected_paths_ask_even_inside_the_root() {
        let verdict = check_write(&root(), r"C:\Aegis-Proyects\state\config\secrets.yaml");
        assert!(!verdict.allowed);
        assert!(verdict.reason.contains("protegida"));
        let verdict = check_write(&root(), r"C:\Aegis-Proyects\.ssh\id_rsa");
        assert!(!verdict.allowed);
    }

    #[test]
    fn destructive_commands_are_marked() {
        assert!(destructive_reason("rm -rf / --no-preserve-root").is_some());
        assert!(destructive_reason("DEL /F /S /Q C:\\temp").is_some());
        assert!(destructive_reason("git reset --hard HEAD~3").is_some());
        assert!(destructive_reason("psql -c 'DROP TABLE users'").is_some());
        assert!(destructive_reason("Remove-Item -Recurse -Force .\\build").is_some());
        assert!(destructive_reason("cargo build -p aegis").is_none());
        assert!(destructive_reason("git status").is_none());
        assert!(destructive_reason("rm -rf target/debug/incremental").is_none());
    }

    #[test]
    fn tool_suffix_strips_the_extension_prefix() {
        assert_eq!(tool_suffix("developer__write"), "write");
        assert_eq!(tool_suffix("write"), "write");
        assert_eq!(tool_suffix("developer__shell"), "shell");
    }

    #[test]
    fn write_target_reads_the_argument_it_traises() {
        let args = serde_json::json!({"path": "docs/a.md"});
        assert_eq!(write_target(args.as_object()).as_deref(), Some("docs/a.md"));
        let args = serde_json::json!({"file_path": " b.md "});
        assert_eq!(write_target(args.as_object()).as_deref(), Some("b.md"));
        let args = serde_json::json!({"command": "ls"});
        assert_eq!(shell_command(args.as_object()).as_deref(), Some("ls"));
        assert!(write_target(None).is_none());
        assert!(shell_command(None).is_none());
    }
}

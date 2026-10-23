//! Fase 8 del plan del 2026-10-23: rewind, unrewind y retry a nivel de transporte ACP.
//!
//! Cubre lo que hasta ahora no tenía ninguna prueba:
//!   * el rewind oculta el último turno y deja el resto visible (`remainingTurns`),
//!   * el rollback (`unrewind`) restaura exactamente lo que el rewind ocultó, que es lo que hace
//!     `on_retry_last_turn` cuando el cambio de perfil falla después de haber rebobinado,
//!   * con el historial restaurado se puede rebobinar otra vez el doble (dos turnos),
//!   * el retry devuelve el texto del último turno y deja el perfil pedido,
//!   * un retry con perfil inválido se rechaza ANTES de tocar el historial: los conteos de
//!     mensajes ocultos antes y después son iguales.
#![recursion_limit = "256"]
#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;

use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{
    run_test, send_custom, Connection, OpenAiFixture, PermissionDecision, Session, SessionData,
    TestConnectionConfig,
};
use common_tests::TURN_CONTEXT_OPEN;
use serde_json::json;
use serial_test::serial;
use std::path::PathBuf;
use std::sync::LazyLock;

const DEFAULT_ACP_TEST_CONFIG: &str =
    "AEGIS_MODEL: gpt-4o\nAEGIS_PROVIDER: openai\nAEGIS_DISABLE_KEYRING: true\n";
const REPLIES: &str = include_str!("acp_test_data/openai_basic.txt");

static ACP_CONFIG_ROOT: LazyLock<tempfile::TempDir> =
    LazyLock::new(|| tempfile::tempdir().unwrap());

fn write_acp_global_config(contents: &str) -> PathBuf {
    std::env::set_var("AEGIS_PATH_ROOT", ACP_CONFIG_ROOT.path());
    std::env::set_var("AEGIS_DISABLE_KEYRING", "1");
    let config_dir = aegis::config::paths::Paths::config_dir();
    std::fs::create_dir_all(&config_dir).unwrap();
    let mut contents = contents.to_string();
    if !contents.contains("AEGIS_DISABLE_KEYRING") {
        contents.push_str("AEGIS_DISABLE_KEYRING: true\n");
    }
    std::fs::write(
        config_dir.join(aegis::config::base::CONFIG_YAML_NAME),
        contents,
    )
    .unwrap();
    config_dir
}

fn campo(valor: &serde_json::Value, nombre: &str) -> u64 {
    valor
        .get(nombre)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| panic!("falta '{nombre}' en {valor}"))
}

#[test]
#[serial]
fn rewind_retry_and_rollback_keep_the_history_consistent() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let expected = AcpServerConnection::expected_session_id();
        let openai = OpenAiFixture::new(
            vec![
                (format!("primer turno{TURN_CONTEXT_OPEN}"), REPLIES),
                (format!("segundo turno{TURN_CONTEXT_OPEN}"), REPLIES),
            ],
            expected.clone(),
        )
        .await;
        let mut conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;
        let SessionData { mut session, .. } = conn.new_session().await.unwrap();
        expected.set(&session.session_id().0);
        let session_id = session.session_id().0.to_string();

        let primero = session
            .prompt("primer turno", PermissionDecision::Cancel)
            .await
            .expect("primer turno");
        assert_eq!(primero.text.trim(), "2");
        let segundo = session
            .prompt("segundo turno", PermissionDecision::Cancel)
            .await
            .expect("segundo turno");
        assert_eq!(segundo.text.trim(), "2");

        // ---- rewind del ultimo turno
        let rewind = send_custom(
            conn.cx(),
            "_aegis/unstable/session/rewind",
            json!({ "sessionId": session_id.clone(), "back": 1 }),
        )
        .await
        .expect("rewind");
        let hidden = campo(&rewind, "hidden");
        assert!(hidden >= 1, "el rewind tiene que ocultar algo: {rewind}");
        assert_eq!(
            campo(&rewind, "remainingTurns"),
            1,
            "con dos turnos, rebobinar uno deja uno visible: {rewind}"
        );
        assert_eq!(
            rewind.get("text").and_then(|v| v.as_str()).map(str::trim),
            Some("segundo turno"),
            "el rewind devuelve el texto del turno para reeditar: {rewind}"
        );

        // ---- rollback: es exactamente lo que hace on_retry_last_turn si el cambio de perfil falla
        let unrewind = send_custom(
            conn.cx(),
            "_aegis/unstable/session/unrewind",
            json!({ "sessionId": session_id.clone() }),
        )
        .await
        .expect("unrewind");
        assert!(
            campo(&unrewind, "restored") >= hidden,
            "el rollback no puede restaurar menos de lo que oculto: {unrewind}"
        );
        let segundo_unrewind = send_custom(
            conn.cx(),
            "_aegis/unstable/session/unrewind",
            json!({ "sessionId": session_id.clone() }),
        )
        .await
        .expect("segundo unrewind");
        assert_eq!(
            campo(&segundo_unrewind, "restored"),
            0,
            "despues del rollback no puede quedar nada oculto de este lote: {segundo_unrewind}"
        );

        // ---- el historial volvio a tener dos turnos: rebobinar el doble llega al primero
        let doble = send_custom(
            conn.cx(),
            "_aegis/unstable/session/rewind",
            json!({ "sessionId": session_id.clone(), "back": 2 }),
        )
        .await
        .expect("rewind de dos");
        assert_eq!(
            campo(&doble, "remainingTurns"),
            0,
            "rebobinar dos turnos en una sesion de dos deja cero: {doble}"
        );
        send_custom(
            conn.cx(),
            "_aegis/unstable/session/unrewind",
            json!({ "sessionId": session_id.clone() }),
        )
        .await
        .expect("unrewind tras el doble");

        // ---- retry: texto del ultimo turno y perfil aplicado
        let retry = send_custom(
            conn.cx(),
            "_aegis/unstable/session/retry",
            json!({ "sessionId": session_id.clone(), "profile": "work" }),
        )
        .await
        .expect("retry");
        assert_eq!(
            retry.get("text").and_then(|v| v.as_str()).map(str::trim),
            Some("segundo turno"),
            "el retry devuelve el turno a repetir: {retry}"
        );
        assert_eq!(
            retry.get("profile").and_then(|v| v.as_str()),
            Some("work"),
            "el retry aplica el perfil pedido: {retry}"
        );
        send_custom(
            conn.cx(),
            "_aegis/unstable/session/unrewind",
            json!({ "sessionId": session_id.clone() }),
        )
        .await
        .expect("deshacer el rewind del retry");

        // ---- un retry con perfil invalido se rechaza sin tocar el historial
        let antes = send_custom(
            conn.cx(),
            "_aegis/unstable/session/rewind",
            json!({ "sessionId": session_id.clone(), "back": 1 }),
        )
        .await
        .expect("rewind de referencia");
        let ocultos_antes = campo(&antes, "hidden");
        send_custom(
            conn.cx(),
            "_aegis/unstable/session/unrewind",
            json!({ "sessionId": session_id.clone() }),
        )
        .await
        .expect("volver atras");

        let rechazado = send_custom(
            conn.cx(),
            "_aegis/unstable/session/retry",
            json!({ "sessionId": session_id.clone(), "profile": "nope" }),
        )
        .await;
        assert!(
            rechazado.is_err(),
            "un perfil invalido tiene que rechazarse: {rechazado:?}"
        );

        let despues = send_custom(
            conn.cx(),
            "_aegis/unstable/session/rewind",
            json!({ "sessionId": session_id.clone(), "back": 1 }),
        )
        .await
        .expect("rewind posterior");
        assert_eq!(
            campo(&despues, "hidden"),
            ocultos_antes,
            "un retry rechazado no puede mover el historial"
        );
    });
}

/// El mismo `_meta.promptId` no puede producir dos llamadas al modelo. La fixture tiene UNA sola
/// respuesta encolada: si el segundo pedido llegara al proveedor, recibiria 417 (peticion
/// inesperada) y el turno fallaria. Es la mitad del escenario 1 del plan que se puede probar sin
/// simular el corte del transporte (el registro de runs ya esta cubierto por
/// `prompt_id_owner_survives_response_handler_drop_and_retries_wait_or_replay`).
#[test]
#[serial]
fn same_prompt_id_answers_twice_without_a_second_model_call() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let expected = AcpServerConnection::expected_session_id();
        let openai = OpenAiFixture::new(
            vec![(format!("tercer turno{TURN_CONTEXT_OPEN}"), REPLIES)],
            expected.clone(),
        )
        .await;
        let mut conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;
        let SessionData { session, .. } = conn.new_session().await.unwrap();
        expected.set(&session.session_id().0);
        let session_id = session.session_id().0.to_string();

        let pedido = json!({
            "sessionId": session_id.clone(),
            "prompt": [{ "type": "text", "text": "tercer turno" }],
            "_meta": { "promptId": "prompt-idempotente-1" }
        });

        let primero = send_custom(conn.cx(), "session/prompt", pedido.clone())
            .await
            .expect("primer prompt con promptId");
        let segundo = send_custom(conn.cx(), "session/prompt", pedido)
            .await
            .expect("el reintento con el mismo promptId tiene que contestar, no fallar");

        assert_eq!(
            primero, segundo,
            "el reintento con el mismo promptId devuelve el mismo resultado"
        );
        assert_eq!(
            segundo.get("stopReason").and_then(|v| v.as_str()),
            Some("end_turn"),
            "el reintento cierra el turno normalmente: {segundo}"
        );

        // Un unico turno de usuario: el reintento no duplico el mensaje en el historial.
        let rewind = send_custom(
            conn.cx(),
            "_aegis/unstable/session/rewind",
            json!({ "sessionId": session_id.clone(), "back": 1 }),
        )
        .await
        .expect("rewind del unico turno");
        assert_eq!(
            campo(&rewind, "remainingTurns"),
            0,
            "la sesion tiene un solo turno de usuario: {rewind}"
        );
    });
}

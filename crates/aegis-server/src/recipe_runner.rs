//! Ejecuta una receta sin terminal interactiva.
//!
//! No reimplementa el agente: levanta el mismo servidor ACP que usa la web y lo
//! maneja con un cliente ACP en proceso sobre dos pipes. Asi una receta corre
//! por el mismo camino que una sesion normal (proveedor, extensiones, permisos,
//! compactacion) y no hay dos runtimes que se puedan desincronizar.

use aegis::acp::server::{serve, AcpBuiltinSelection};
use aegis::acp::server_factory::{AcpServer, AcpServerFactoryConfig};
use aegis::agents::AegisPlatform;
use aegis::config::paths::Paths;
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, Meta, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{ByteStreams, Client, ConnectionTo};
use anyhow::{bail, Result};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

pub async fn run(path: PathBuf, text: Option<String>, cwd: PathBuf) -> Result<()> {
    let recipe = aegis::recipe::Recipe::from_file_path(&path)?;
    let deeplink = aegis::recipe_deeplink::encode(&recipe)?;
    let prompt_text = match text.or_else(|| recipe.prompt.clone()) {
        Some(prompt) => prompt,
        None => bail!(
            "recipe `{}` no define prompt; pasá --text \"...\"",
            recipe.title
        ),
    };

    let server = Arc::new(AcpServer::new(AcpServerFactoryConfig {
        builtins: AcpBuiltinSelection::from_requested(vec!["developer".to_string()]),
        config_dir: Paths::config_dir(),
        aegis_platform: AegisPlatform::AegisCli,
        additional_source_roots: Vec::new(),
        session_cwd: Some(cwd.clone()),
        enable_scheduler: false,
    }));
    let agent = server.create_agent().await?;

    let (client_out, server_in) = tokio::io::duplex(128 * 1024);
    let (server_out, client_in) = tokio::io::duplex(128 * 1024);

    let server_task = tokio::spawn(async move {
        match serve(agent, server_in.compat(), server_out.compat_write()).await {
            Ok(()) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    });

    let client_result = Client
        .builder()
        .name("aegis-serve-recipe")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                print_update(&notification);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                match request.options.first().map(|option| option.option_id.clone()) {
                    Some(option_id) => responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
                    )),
                    None => responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    )),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(
            ByteStreams::new(client_out.compat_write(), client_in.compat()),
            async move |cx: ConnectionTo<agent_client_protocol::Agent>| {
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                let mut meta = Meta::new();
                meta.insert(
                    "recipeDeeplink".to_string(),
                    serde_json::Value::String(deeplink),
                );
                let mut request = NewSessionRequest::new(cwd);
                request.meta = Some(meta);

                let session = cx.send_request(request).block_task().await?;
                let prompt = PromptRequest::new(
                    session.session_id.clone(),
                    vec![ContentBlock::Text(TextContent::new(prompt_text))],
                );
                cx.send_request(prompt).block_task().await?;
                Ok(())
            },
        )
        .await;

    match client_result {
        Ok(()) => {
            println!();
            std::io::stdout().flush().ok();
            let _ = server_task.await;
            Ok(())
        }
        Err(error) => {
            server_task.abort();
            Err(anyhow::anyhow!("acp: {error}"))
        }
    }
}

fn print_update(notification: &SessionNotification) {
    match &notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            if let ContentBlock::Text(text) = &chunk.content {
                print!("{}", text.text);
                std::io::stdout().flush().ok();
            }
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            if let ContentBlock::Text(text) = &chunk.content {
                eprint!("{}", text.text);
                std::io::stderr().flush().ok();
            }
        }
        SessionUpdate::ToolCall(call) => {
            eprintln!("\n[tool] {}", call.title);
        }
        SessionUpdate::ToolCallUpdate(update) => {
            if let Some(status) = &update.fields.status {
                eprintln!("[tool] {:?}", status);
            }
        }
        _ => {}
    }
}

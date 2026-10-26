#![recursion_limit = "256"]

//! Backend del harness: levanta el servidor ACP sobre HTTP/WebSocket.
//!
//! Es el `serve` de siempre, sin el CLI. Antes vivia dentro de `aegis-cli` (un
//! subcomando de un binario de 30k lineas con TUI); ahora es un binario propio
//! con `main` propio.

mod recipe_runner;

use aegis::acp::server::AcpBuiltinSelection;
use aegis::acp::server_factory::{AcpServer, AcpServerFactoryConfig};
use aegis::acp::transport::create_router;
use aegis::agents::AegisPlatform;
use aegis::config::paths::Paths;
use aegis::config::Config;
use aegis::source_roots::SourceRoot;
use anyhow::Result;
use clap::{CommandFactory, Parser, ValueEnum};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::{info, warn};

const SECRET_KEY_ENV: &str = "AEGIS_SERVER__SECRET_KEY";

#[derive(ValueEnum, Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ServePlatform {
    #[default]
    Cli,
    Desktop,
}

impl From<ServePlatform> for AegisPlatform {
    fn from(platform: ServePlatform) -> Self {
        match platform {
            ServePlatform::Cli => AegisPlatform::AegisCli,
            ServePlatform::Desktop => AegisPlatform::AegisDesktop,
        }
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "aegis-serve",
    author,
    version,
    about = "Aegis harness: ACP server over HTTP and WebSocket",
    long_about = None
)]
struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    #[arg(long, default_value_t = 3284)]
    port: u16,

    #[arg(long, help = "Serve ACP over TLS")]
    tls: bool,

    #[arg(long = "tls-cert-path", value_name = "PATH")]
    tls_cert_path: Option<String>,

    #[arg(long = "tls-key-path", value_name = "PATH")]
    tls_key_path: Option<String>,

    #[arg(long, value_enum, default_value_t = ServePlatform::Cli)]
    platform: ServePlatform,

    #[arg(
        long = "with-builtin",
        value_name = "NAME",
        help = "Add builtin extensions by name (e.g., 'developer' or multiple: 'developer,github')",
        value_delimiter = ',',
        action = clap::ArgAction::Append
    )]
    builtins: Vec<String>,

    #[arg(
        long = "dangerously-unauthenticated",
        help = "Start the ACP endpoint without requiring AEGIS_SERVER__SECRET_KEY"
    )]
    dangerously_unauthenticated: bool,

    #[arg(
        long = "allowed-origin",
        value_name = "ORIGIN",
        action = clap::ArgAction::Append,
        help = "Allow an exact Origin value for ACP CORS; may be specified multiple times and replaces the default loopback origins"
    )]
    allowed_origins: Vec<String>,

    #[arg(long, help = "Enable scheduled recipe execution")]
    enable_scheduler: bool,

    #[arg(
        long,
        help = "Print the resolved store paths and exit (replaces `aegis info`)"
    )]
    print_paths: bool,

    #[arg(
        long,
        help = "Serve ACP over stdin/stdout instead of HTTP/WebSocket (replaces `aegis acp`)"
    )]
    stdio: bool,

    #[arg(
        long,
        help = "List installed skills and exit (replaces `aegis skills list`)"
    )]
    list_skills: bool,

    #[arg(
        long,
        help = "Consolidate operator memory (dedupe, promote, archive) and exit"
    )]
    memory_consolidate: bool,

    #[arg(
        long,
        value_name = "N",
        help = "List the N most recent sessions and exit (replaces `aegis session list`)"
    )]
    list_sessions: Option<usize>,

    #[arg(
        long,
        value_name = "PATH",
        help = "Run a recipe file headlessly through an in-process ACP session and exit (replaces `aegis run --recipe`)"
    )]
    run_recipe: Option<String>,

    #[arg(
        long,
        value_name = "TEXT",
        help = "Prompt to start the recipe session with (defaults to the recipe's own prompt)"
    )]
    text: Option<String>,

    #[arg(
        long,
        value_name = "DIR",
        help = "Working directory for the recipe session (defaults to the current directory)"
    )]
    recipe_cwd: Option<String>,
}

fn generate_secret_key() -> String {
    use rand::distr::{Alphanumeric, SampleString};

    format!(
        "aegis-acp-{}",
        Alphanumeric.sample_string(&mut rand::rng(), 32)
    )
}

fn print_paths() {
    let data = Paths::data_dir();
    println!("config_dir    {}", Paths::config_dir().display());
    println!(
        "config.yaml   {}",
        Paths::config_dir().join("config.yaml").display()
    );
    println!("data_dir      {}", data.display());
    println!(
        "sessions.db   {}",
        data.join("sessions").join("sessions.db").display()
    );
    println!("state_dir     {}", Paths::state_dir().display());
    println!("logs_dir      {}", Paths::in_state_dir("logs").display());
    println!("agents_home   {}", Paths::agents_home_dir().display());
    println!("version       {}", env!("CARGO_PKG_VERSION"));
}

fn list_skills() {
    let cwd = std::env::current_dir().ok();
    let mut skills = aegis::skills::list_installed_skills(cwd.as_deref());
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    for skill in &skills {
        let description = skill.description.replace(['\n', '\r'], " ");
        println!("{}\t{}\t{}", skill.name, description, skill.path);
    }
    println!("({} skills)", skills.len());
}

async fn list_sessions(limit: usize) -> Result<()> {
    let manager = aegis::session::SessionManager::instance();
    let mut sessions = manager.list_all_sessions().await?;
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    sessions.truncate(limit);
    for session in sessions {
        println!(
            "{}\t{}\t{}\t{}",
            session.id,
            session.updated_at.to_rfc3339(),
            session.message_count,
            session.name
        );
    }
    Ok(())
}

async fn serve(args: Args) -> Result<()> {
    if args.print_paths {
        print_paths();
        return Ok(());
    }

    let builtins = AcpBuiltinSelection::from_requested(args.builtins);

    let additional_source_roots = Config::global()
        .get_param::<String>("ADDITIONAL_AGENT_SOURCE_ROOTS")
        .ok()
        .map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|path| {
            let path = path.canonicalize().unwrap_or(path);
            SourceRoot::read_only(path)
        })
        .collect();

    let server = Arc::new(AcpServer::new(AcpServerFactoryConfig {
        builtins,
        config_dir: Paths::config_dir(),
        aegis_platform: args.platform.into(),
        additional_source_roots,
        session_cwd: None,
        enable_scheduler: args.enable_scheduler,
    }));

    let env_secret = std::env::var(SECRET_KEY_ENV)
        .ok()
        .map(|secret| secret.trim().to_string())
        .filter(|secret| !secret.is_empty());
    let require_token = env_secret.is_some();
    if !require_token && !args.dangerously_unauthenticated {
        anyhow::bail!(
            "{SECRET_KEY_ENV} must be set to start `aegis-serve`; pass --dangerously-unauthenticated to run without ACP authentication"
        );
    }
    if args.dangerously_unauthenticated && !require_token {
        warn!(
            "{SECRET_KEY_ENV} is not set and --dangerously-unauthenticated was passed; the ACP endpoint will accept unauthenticated connections"
        );
    }

    let additional_allowed_origins = args
        .allowed_origins
        .iter()
        .map(|origin| {
            let origin = origin.trim();
            if origin.is_empty() || origin == "*" {
                anyhow::bail!("--allowed-origin must be a non-wildcard Origin value");
            }
            axum::http::HeaderValue::from_str(origin).map_err(|error| {
                anyhow::anyhow!("invalid --allowed-origin value `{origin}`: {error}")
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let secret_key = env_secret.unwrap_or_else(generate_secret_key);
    if let Err(error) = server.start_scheduler().await {
        warn!("Scheduler failed to start; scheduled jobs will not run until a client connects: {error}");
    }

    let router = create_router(
        server,
        secret_key,
        require_token,
        additional_allowed_origins,
    );

    let config = Config::global();
    let tls_cert_path = args
        .tls_cert_path
        .or_else(|| config.get_param::<String>("AEGIS_TLS_CERT_PATH").ok());
    let tls_key_path = args
        .tls_key_path
        .or_else(|| config.get_param::<String>("AEGIS_TLS_KEY_PATH").ok());
    let tls = args.tls
        || config.get_param::<bool>("AEGIS_TLS").unwrap_or(false)
        || tls_cert_path.is_some()
        || tls_key_path.is_some();

    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    if tls {
        #[cfg(any(feature = "rustls-tls", feature = "native-tls"))]
        let tls_setup = aegis::acp::transport::tls::setup_tls(
            tls_cert_path.as_deref(),
            tls_key_path.as_deref(),
        )
        .await?;

        #[cfg(any(feature = "rustls-tls", feature = "native-tls"))]
        info!(
            "Starting ACP server on https://{} (fingerprint {})",
            addr, tls_setup.fingerprint
        );

        #[cfg(feature = "rustls-tls")]
        axum_server::bind_rustls(addr, tls_setup.config)
            .serve(router.into_make_service_with_connect_info::<SocketAddr>())
            .await?;

        #[cfg(feature = "native-tls")]
        axum_server::bind_openssl(addr, tls_setup.config)
            .serve(router.into_make_service_with_connect_info::<SocketAddr>())
            .await?;

        #[cfg(not(any(feature = "rustls-tls", feature = "native-tls")))]
        {
            let _ = (tls_cert_path, tls_key_path);
            anyhow::bail!(
                "TLS was requested but no TLS backend is enabled. \
                 Enable the `rustls-tls` or `native-tls` feature."
            );
        }
    } else {
        info!("Starting ACP server on http://{}", addr);
        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await?;
    }

    Ok(())
}

fn init_logging() -> Result<()> {
    use tracing_subscriber::util::SubscriberInitExt;

    aegis::providers::utils::init_aegis_request_log()?;
    let config = aegis::logging::LoggingConfig {
        component: "serve",
        name: None,
        extra_directives: &["aegis_server=info"],
        console: false,
        json: true,
    };
    aegis::logging::build_logging_subscriber(&config)?
        .try_init()
        .map_err(|e| anyhow::anyhow!("Failed to set global subscriber: {}", e))?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Sin argumentos no arrancamos el servidor: el alias del PATH mostraria la ayuda en vez
    // de intentar escuchar en el 3284 y chocar con el serve vivo.
    if std::env::args_os().len() == 1 {
        Args::command().print_help()?;
        println!();
        return Ok(());
    }

    let args = Args::parse();

    if args.print_paths {
        print_paths();
        return Ok(());
    }

    if args.stdio {
        return aegis::acp::server::run(args.builtins.clone(), args.enable_scheduler).await;
    }

    if args.list_skills {
        list_skills();
        return Ok(());
    }

    if args.memory_consolidate {
        let path = aegis::memory::store::store_path();
        let report = aegis::memory::store::consolidate(&path)?;
        println!(
            "memoria: {} hechos ({} confirmados, {} candidatos, {} stale, {} rechazados)",
            report.total, report.confirmed, report.candidates, report.stale, report.rejected
        );
        println!(
            "duplicados fusionados: {} | promovidos: {} | stale nuevos: {} | cambios: {}",
            report.duplicates_merged,
            report.promoted.len(),
            report.marked_stale.len(),
            report.changed
        );
        println!("informe: {}", aegis::memory::store::report_path().display());
        return Ok(());
    }

    if let Some(limit) = args.list_sessions {
        return list_sessions(limit).await;
    }

    if let Some(path) = args.run_recipe.clone() {
        let cwd = match args.recipe_cwd.clone() {
            Some(dir) => std::path::PathBuf::from(dir),
            None => std::env::current_dir()?,
        };
        if !cwd.is_absolute() {
            anyhow::bail!("--recipe-cwd must be an absolute path");
        }
        return recipe_runner::run(std::path::PathBuf::from(path), args.text.clone(), cwd).await;
    }

    if let Err(e) = init_logging() {
        eprintln!("Warning: Failed to initialize logging: {}", e);
    }

    #[cfg(feature = "online-model-meta")]
    aegis::model_catalog::initialize();

    #[cfg(feature = "bundled-mcp")]
    aegis::builtin_extension::register_builtin_extensions(aegis_mcp::BUILTIN_EXTENSIONS.clone());

    serve(args).await
}

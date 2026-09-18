//! backtest-service — HTTP around `backtest-core`.
//!
//! The engine is synchronous and CPU-bound; this crate gives it a queue, a
//! progress feed, and somewhere to put results. Runs execute on
//! `spawn_blocking` so a long scan never occupies the async runtime.
//!
//! # Where the strategy is
//!
//! Nowhere, yet. `DetectorRegistry` starts empty, and a run is refused with a
//! clear error rather than reporting a tidy zero-trade result. The rules are
//! still being defined, and a guessed placeholder would end up shared with the
//! live scanner. Register a `DetectorFactory` in [`build_registry`] when they
//! land — nothing else changes.

mod instruments;
mod jobs;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use backtest_core::engine::detector::DetectorRegistry;
use backtest_core::engine::runner::{run, RunRequest, ScanTask};
use backtest_core::engine::sim::IntrabarPolicy;
use backtest_core::store::{cache_path, Bars};
use backtest_core::{CoreError, SimConfig, Timeframe, ENGINE_VERSION};
use serde::Serialize;
use serde_json::json;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::jobs::{JobRegistry, RunSpec};

#[derive(Clone)]
struct AppState {
    jobs: JobRegistry,
    registry: Arc<DetectorRegistry>,
    bar_cache: PathBuf,
}

/// Where implementations of the strategy get registered.
///
/// Empty on purpose. See the module docs.
fn build_registry() -> DetectorRegistry {
    DetectorRegistry::new()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backtest_service=info,tower_http=warn".into()),
        )
        .init();

    let bar_cache = PathBuf::from(
        std::env::var("BAR_CACHE_DIR").unwrap_or_else(|_| "/var/lib/totaltrading/bars".into()),
    );
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8004);

    let registry = build_registry();
    if registry.is_empty() {
        tracing::warn!(
            "no detectors registered — runs will be refused until the strategy rules land"
        );
    }

    let state = AppState {
        jobs: JobRegistry::new(),
        registry: Arc::new(registry),
        bar_cache: bar_cache.clone(),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/ready", get(health))
        .route("/detectors", get(detectors))
        .route("/runs", get(list_runs).post(start_run))
        .route("/runs/:id", get(get_run).delete(cancel_run))
        .route("/runs/:id/progress", get(run_progress))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(%addr, cache = %bar_cache.display(), "backtest-service listening");

    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

// ------------------------------------------------------------------ handlers

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "backtest-engine",
        "engine_version": ENGINE_VERSION,
        "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "bar_cache": state.bar_cache.display().to_string(),
        "bar_cache_present": state.bar_cache.is_dir(),
        "detectors": state.registry.names(),
        "detection_implemented": !state.registry.is_empty(),
    }))
}

async fn detectors(State(state): State<AppState>) -> impl IntoResponse {
    let names = state.registry.names();
    Json(json!({
        "detectors": names,
        "detail": if names.is_empty() {
            Some("No detector is registered. The strategy rules are still being defined.")
        } else {
            None
        },
    }))
}

async fn list_runs(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.jobs.list())
}

async fn get_run(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    state
        .jobs
        .get(id, true)
        .map(|view| Json(view).into_response())
        .ok_or_else(|| ApiError::not_found("No run with that id."))
}

async fn run_progress(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    state
        .jobs
        .get(id, false)
        .map(|view| Json(view).into_response())
        .ok_or_else(|| ApiError::not_found("No run with that id."))
}

async fn cancel_run(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    if state.jobs.cancel(id) {
        Ok((StatusCode::ACCEPTED, Json(json!({ "cancelling": id }))).into_response())
    } else {
        Err(ApiError::not_found("No run with that id is still in flight."))
    }
}

async fn start_run(
    State(state): State<AppState>,
    Json(spec): Json<RunSpec>,
) -> Result<Response, ApiError> {
    if spec.symbols.is_empty() {
        return Err(ApiError::bad_request("Give at least one symbol to scan."));
    }
    if spec.from_ts >= spec.to_ts {
        return Err(ApiError::bad_request("`from_ts` must come before `to_ts`."));
    }

    // Fail before queueing rather than after: a run that cannot start should
    // say so in the response to the request that asked for it.
    state
        .registry
        .get(&spec.detector)
        .map_err(|e| ApiError::unprocessable(e.to_string()))?;

    let timeframe = parse_timeframe(&spec.timeframe)?;
    let higher = spec
        .higher_timeframes
        .iter()
        .map(|t| parse_timeframe(t))
        .collect::<Result<Vec<_>, _>>()?;

    let sim = apply_overrides(SimConfig::default(), &spec)?;

    // Open every mapped file up front. Mapping is cheap, and a missing symbol
    // is far better reported now than three minutes into a scan.
    let mut tasks = Vec::with_capacity(spec.symbols.len());
    for symbol in &spec.symbols {
        let task = build_task(&state.bar_cache, symbol, timeframe, &higher, &sim)
            .map_err(|e| ApiError::unprocessable(e.to_string()))?;
        tasks.push(task);
    }

    let (id, progress) = state.jobs.create(&spec);
    let request = RunRequest {
        detector: spec.detector.clone(),
        from_ts: spec.from_ts,
        to_ts: spec.to_ts,
        sim,
    };

    let jobs = state.jobs.clone();
    let registry = Arc::clone(&state.registry);
    let detector_name = spec.detector.clone();

    // The engine is blocking and CPU-bound. Running it on the async runtime
    // would stall every other request for the length of the scan.
    tokio::task::spawn_blocking(move || {
        jobs.mark_running(id);

        let factory = match registry.get(&detector_name) {
            Ok(f) => f,
            Err(e) => {
                jobs.fail(id, e.to_string(), false);
                return;
            }
        };

        match run(tasks, &request, factory, &progress) {
            Ok(result) => {
                tracing::info!(
                    %id,
                    bars = result.bars_processed,
                    trades = result.metrics.total_trades,
                    ms = result.elapsed_ms,
                    "run finished"
                );
                jobs.complete(id, result);
            }
            Err(CoreError::Cancelled) => {
                tracing::info!(%id, "run cancelled");
                jobs.fail(id, "cancelled".into(), true);
            }
            Err(e) => {
                tracing::warn!(%id, error = %e, "run failed");
                jobs.fail(id, e.to_string(), false);
            }
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "id": id, "status": "queued" })),
    )
        .into_response())
}

// ------------------------------------------------------------------- helpers

fn parse_timeframe(raw: &str) -> Result<Timeframe, ApiError> {
    Timeframe::from_str(raw).map_err(|e| ApiError::bad_request(e))
}

fn build_task(
    cache: &std::path::Path,
    symbol: &str,
    timeframe: Timeframe,
    higher: &[Timeframe],
    base_sim: &SimConfig,
) -> Result<ScanTask, CoreError> {
    let bars = Arc::new(Bars::open(cache_path(cache, symbol, timeframe))?);
    let higher = higher
        .iter()
        .map(|&tf| Bars::open(cache_path(cache, symbol, tf)).map(Arc::new))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ScanTask {
        bars,
        higher,
        sim: instruments::default_sim_for(symbol, base_sim),
    })
}

fn apply_overrides(mut sim: SimConfig, spec: &RunSpec) -> Result<SimConfig, ApiError> {
    let Some(o) = spec.sim.as_ref() else {
        return Ok(sim);
    };

    if let Some(v) = o.initial_balance {
        if v <= 0.0 {
            return Err(ApiError::bad_request("`initial_balance` must be positive."));
        }
        sim.initial_balance = v;
    }
    if let Some(v) = o.risk_percent {
        if !(0.0..=100.0).contains(&v) || v <= 0.0 {
            return Err(ApiError::bad_request(
                "`risk_percent` must be between 0 and 100.",
            ));
        }
        sim.risk_percent = v;
    }
    if let Some(v) = o.commission_per_lot {
        sim.commission_per_lot = v.max(0.0);
    }
    if let Some(v) = o.extra_spread_points {
        sim.extra_spread_points = v.max(0.0);
    }
    if let Some(v) = o.slippage_points {
        sim.slippage_points = v.max(0.0);
    }
    if let Some(v) = o.max_open_per_symbol {
        sim.max_open_per_symbol = v.max(1);
    }
    if let Some(raw) = o.intrabar.as_deref() {
        sim.intrabar = match raw.to_ascii_lowercase().as_str() {
            "pessimistic" => IntrabarPolicy::Pessimistic,
            "optimistic" => IntrabarPolicy::Optimistic,
            other => {
                return Err(ApiError::bad_request(format!(
                    "`intrabar` must be \"pessimistic\" or \"optimistic\", got \"{other}\"."
                )))
            }
        };
    }

    Ok(sim)
}

// --------------------------------------------------------------------- errors

#[derive(Debug, Serialize)]
struct ApiError {
    #[serde(skip)]
    status: StatusCode,
    detail: String,
}

impl ApiError {
    fn bad_request(detail: impl Into<String>) -> Self {
        ApiError { status: StatusCode::BAD_REQUEST, detail: detail.into() }
    }
    fn not_found(detail: impl Into<String>) -> Self {
        ApiError { status: StatusCode::NOT_FOUND, detail: detail.into() }
    }
    /// For a request that parsed fine but cannot be carried out — a missing
    /// symbol in the cache, or no detector registered.
    fn unprocessable(detail: impl Into<String>) -> Self {
        ApiError { status: StatusCode::UNPROCESSABLE_ENTITY, detail: detail.into() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
    }
}

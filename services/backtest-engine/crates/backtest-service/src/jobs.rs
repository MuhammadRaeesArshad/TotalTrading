//! Run registry: what has been asked for, what is in flight, what finished.
//!
//! Deliberately in-process. A backtest is a long CPU job on one machine that
//! owns the bar cache; putting the queue in Redis would add a hop and a
//! serialisation format to coordinate a single worker with itself. If this
//! ever runs on more than one node, the queue moves to Redis and this file is
//! the only thing that changes.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use backtest_core::engine::runner::{Progress, RunResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// What the caller asked for. Symbols and timeframes are named, not paths —
/// the service resolves them against its own bar cache.
#[derive(Debug, Clone, Deserialize)]
pub struct RunSpec {
    /// Which rule set to run. Must be registered; see `GET /detectors`.
    pub detector: String,
    pub symbols: Vec<String>,
    /// The timeframe the scan steps through.
    pub timeframe: String,
    /// Higher timeframes the rules read for context. Optional.
    #[serde(default)]
    pub higher_timeframes: Vec<String>,
    /// Unix seconds, inclusive.
    pub from_ts: i64,
    pub to_ts: i64,
    #[serde(default)]
    pub sim: Option<SimOverrides>,
}

/// Simulation knobs a caller may set. Anything omitted keeps the per-symbol
/// default, which is where point size and point value come from — those are
/// properties of the instrument, not of the request.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SimOverrides {
    pub initial_balance: Option<f64>,
    pub risk_percent: Option<f64>,
    pub commission_per_lot: Option<f64>,
    pub extra_spread_points: Option<f64>,
    pub slippage_points: Option<f64>,
    pub max_open_per_symbol: Option<usize>,
    /// "pessimistic" (default) or "optimistic".
    pub intrabar: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JobView {
    pub id: Uuid,
    pub status: JobStatus,
    pub detector: String,
    pub symbols: Vec<String>,
    pub timeframe: String,
    pub progress_pct: f64,
    pub bars_done: usize,
    pub bars_total: usize,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<RunResult>,
}

pub struct Job {
    pub id: Uuid,
    pub status: JobStatus,
    pub detector: String,
    pub symbols: Vec<String>,
    pub timeframe: String,
    pub progress: Arc<Progress>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub error: Option<String>,
    pub result: Option<RunResult>,
}

impl Job {
    /// `include_result` is the caller's choice because a completed run carries
    /// its whole trade log — fine on the detail endpoint, ruinous on a list.
    pub fn view(&self, include_result: bool) -> JobView {
        use std::sync::atomic::Ordering;

        JobView {
            id: self.id,
            status: self.status,
            detector: self.detector.clone(),
            symbols: self.symbols.clone(),
            timeframe: self.timeframe.clone(),
            progress_pct: match self.status {
                JobStatus::Completed => 100.0,
                _ => self.progress.percent(),
            },
            bars_done: self.progress.bars_done.load(Ordering::Relaxed),
            bars_total: self.progress.bars_total.load(Ordering::Relaxed),
            created_at: self.created_at,
            finished_at: self.finished_at,
            error: self.error.clone(),
            result: include_result.then(|| self.result.clone()).flatten(),
        }
    }
}

#[derive(Clone, Default)]
pub struct JobRegistry {
    jobs: Arc<RwLock<HashMap<Uuid, Job>>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self, spec: &RunSpec) -> (Uuid, Arc<Progress>) {
        let id = Uuid::new_v4();
        let progress = Arc::new(Progress::default());

        let job = Job {
            id,
            status: JobStatus::Queued,
            detector: spec.detector.clone(),
            symbols: spec.symbols.clone(),
            timeframe: spec.timeframe.clone(),
            progress: Arc::clone(&progress),
            created_at: now(),
            finished_at: None,
            error: None,
            result: None,
        };

        self.jobs.write().unwrap().insert(id, job);
        (id, progress)
    }

    pub fn mark_running(&self, id: Uuid) {
        if let Some(job) = self.jobs.write().unwrap().get_mut(&id) {
            job.status = JobStatus::Running;
        }
    }

    pub fn complete(&self, id: Uuid, result: RunResult) {
        if let Some(job) = self.jobs.write().unwrap().get_mut(&id) {
            job.status = JobStatus::Completed;
            job.finished_at = Some(now());
            job.result = Some(result);
        }
    }

    pub fn fail(&self, id: Uuid, error: String, cancelled: bool) {
        if let Some(job) = self.jobs.write().unwrap().get_mut(&id) {
            job.status = if cancelled {
                JobStatus::Cancelled
            } else {
                JobStatus::Failed
            };
            job.finished_at = Some(now());
            job.error = Some(error);
        }
    }

    pub fn cancel(&self, id: Uuid) -> bool {
        match self.jobs.read().unwrap().get(&id) {
            Some(job)
                if matches!(job.status, JobStatus::Queued | JobStatus::Running) =>
            {
                job.progress.cancel();
                true
            }
            _ => false,
        }
    }

    pub fn get(&self, id: Uuid, include_result: bool) -> Option<JobView> {
        self.jobs.read().unwrap().get(&id).map(|j| j.view(include_result))
    }

    /// Newest first. Never includes results — see [`Job::view`].
    pub fn list(&self) -> Vec<JobView> {
        let jobs = self.jobs.read().unwrap();
        let mut views: Vec<JobView> = jobs.values().map(|j| j.view(false)).collect();
        views.sort_unstable_by(|a, b| b.created_at.cmp(&a.created_at));
        views
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

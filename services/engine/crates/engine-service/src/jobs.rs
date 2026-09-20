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

use engine_core::engine::runner::{Progress, RunResult};

use crate::importer::{ImportProgress, ImportReport};
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
    /// The strategy's own settings; `null` uses its defaults.
    #[serde(default)]
    pub params: serde_json::Value,
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
    /// Per-symbol broker figures, keyed by symbol. Anything absent keeps the
    /// engine's own default for that instrument.
    #[serde(default)]
    pub symbol_sim: std::collections::HashMap<String, SymbolSim>,
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
    /// "shared" (default) — one balance for the whole run — or "per_symbol",
    /// which gives every pair its own copy of `initial_balance`.
    pub capital: Option<String>,
    /// "fixed" (default) — risk a percent of the starting balance every trade,
    /// so the account cannot run out — or "compound", which risks a percent of
    /// equity as it stands and can be wiped out.
    pub sizing: Option<String>,
}

/// What the broker says about one instrument.
///
/// The engine guesses point size from the symbol's name, which is right for
/// the majors and a guess everywhere else. The gateway already stores the
/// terminal's own figures, so anything it sends here wins — and swap it must
/// send, because no rule of thumb produces a carry rate.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SymbolSim {
    pub point_size: Option<f64>,
    pub point_value_per_lot: Option<f64>,
    pub volume_min: Option<f64>,
    pub volume_max: Option<f64>,
    pub volume_step: Option<f64>,
    /// Points per lot per night. Negative is a charge.
    pub swap_long_points: Option<f64>,
    pub swap_short_points: Option<f64>,
    /// 0 is Sunday.
    pub swap_triple_weekday: Option<u8>,
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

// ------------------------------------------------------------------ imports

/// One history import. Held in memory: what it produces lives on disk in the
/// bar cache, so losing this record on restart loses only the report.
pub struct ImportJob {
    pub status: JobStatus,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub progress: Arc<ImportProgress>,
    pub report: Option<ImportReport>,
}

#[derive(Debug, Serialize)]
pub struct ImportView {
    pub id: Uuid,
    pub status: JobStatus,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub series_total: usize,
    pub series_done: usize,
    pub bars_done: usize,
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ImportReport>,
}

/// Imports run one at a time: they all go through the same terminal, and two
/// interleaved would each take twice as long and finish no sooner.
#[derive(Clone, Default)]
pub struct ImportRegistry {
    jobs: Arc<RwLock<HashMap<Uuid, ImportJob>>>,
}

/// Finished imports kept for their reports. Older ones are dropped.
const KEEP_FINISHED_IMPORTS: usize = 20;

impl ImportRegistry {
    /// Starts tracking a new import, or returns `None` if one is already running.
    pub fn try_create(&self) -> Option<(Uuid, Arc<ImportProgress>)> {
        let mut jobs = self.jobs.write().unwrap();
        if jobs.values().any(|j| j.status == JobStatus::Running) {
            return None;
        }

        // Bound memory: keep only the most recent finished imports.
        let mut finished: Vec<(Uuid, u64)> = jobs
            .iter()
            .filter(|(_, j)| j.status != JobStatus::Running)
            .map(|(id, j)| (*id, j.created_at))
            .collect();
        finished.sort_unstable_by(|a, b| b.1.cmp(&a.1));
        for (id, _) in finished.into_iter().skip(KEEP_FINISHED_IMPORTS) {
            jobs.remove(&id);
        }

        let id = Uuid::new_v4();
        let progress = Arc::new(ImportProgress::default());
        jobs.insert(id, ImportJob {
            status: JobStatus::Running,
            created_at: now(),
            finished_at: None,
            progress: Arc::clone(&progress),
            report: None,
        });
        Some((id, progress))
    }

    pub fn finish(&self, id: Uuid, report: Option<ImportReport>) {
        if let Some(job) = self.jobs.write().unwrap().get_mut(&id) {
            job.status = if report.is_some() { JobStatus::Completed } else { JobStatus::Failed };
            job.finished_at = Some(now());
            job.report = report;
        }
    }

    pub fn get(&self, id: Uuid) -> Option<ImportView> {
        self.jobs.read().unwrap().get(&id).map(|j| view(id, j, true))
    }

    /// Newest first, without the per-series reports.
    pub fn list(&self) -> Vec<ImportView> {
        let jobs = self.jobs.read().unwrap();
        let mut views: Vec<ImportView> = jobs.iter().map(|(id, j)| view(*id, j, false)).collect();
        views.sort_unstable_by(|a, b| b.created_at.cmp(&a.created_at));
        views
    }
}

fn view(id: Uuid, j: &ImportJob, with_report: bool) -> ImportView {
    use std::sync::atomic::Ordering;
    ImportView {
        id,
        status: j.status,
        created_at: j.created_at,
        finished_at: j.finished_at,
        series_total: j.progress.series_total.load(Ordering::Relaxed),
        series_done: j.progress.series_done.load(Ordering::Relaxed),
        bars_done: j.progress.bars_done.load(Ordering::Relaxed),
        current: j.progress.current.lock().map(|c| c.clone()).unwrap_or_default(),
        report: if with_report { j.report.clone() } else { None },
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn only_one_import_runs_at_a_time() {
        let reg = ImportRegistry::default();
        let (first, _) = reg.try_create().expect("first import starts");
        assert!(reg.try_create().is_none(), "a second import is refused while one runs");

        reg.finish(first, Some(ImportReport::default()));
        assert_eq!(reg.get(first).unwrap().status, JobStatus::Completed);
        assert!(reg.try_create().is_some(), "the next one starts once the first is done");
    }

    #[test]
    fn a_panicked_import_is_marked_failed_and_frees_the_slot() {
        let reg = ImportRegistry::default();
        let (id, _) = reg.try_create().unwrap();
        reg.finish(id, None);
        assert_eq!(reg.get(id).unwrap().status, JobStatus::Failed);
        assert!(reg.try_create().is_some());
    }
}

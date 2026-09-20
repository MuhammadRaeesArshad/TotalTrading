//! The backtest hot path.
//!
//! Deliberately synchronous and free of network I/O: this crate opens mapped
//! files, runs the scan, and hands back a result. The service crate wraps it
//! in HTTP, Mongo and a job queue.
//!
//! # What is here, and what is not
//!
//! The engine is complete: storage, windowing, multi-timeframe alignment,
//! order simulation, metrics. The *rules* are not — see
//! [`engine::detector`] for why nothing stands in for them.

pub mod error;
pub mod store;
pub mod timeframe;

pub mod engine;

pub use error::{CoreError, Result};
pub use timeframe::Timeframe;

pub use engine::detector::{
    Detector, DetectorFactory, DetectorRegistry, Direction, NoDetector, Signal, SignalSink,
};
pub use engine::metrics::{EquityPoint, Metrics};
pub use engine::runner::{run, task_from_cache, CapitalMode, Progress, RunRequest, RunResult,
    ScanTask, ENGINE_VERSION};
pub use engine::sim::{ExitReason, IntrabarPolicy, SimConfig, SizingMode, Trade};
pub use engine::window::BarCtx;
pub use store::{cache_path, write_bars, Bars, InputBar};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("{path}: not a bar file (bad magic). Rebuild it with the bar importer.")]
    BadMagic { path: String },

    #[error("{path}: written by format v{found}, this build reads v{expected}")]
    VersionMismatch {
        path: String,
        found: u16,
        expected: u16,
    },

    #[error("{path}: header says {expected} bars, file holds {actual}. Truncated write?")]
    Truncated {
        path: String,
        expected: usize,
        actual: usize,
    },

    #[error("'{symbol}' is not a valid symbol name. Use letters, digits and . _ - # only.")]
    InvalidSymbol { symbol: String },

    #[error("{path}: unknown timeframe code {code}")]
    UnknownTimeframe { path: String, code: u16 },

    #[error("no bars for {symbol} {timeframe} in the requested window")]
    NoBars {
        symbol: String,
        timeframe: String,
    },

    #[error("{symbol} {timeframe}: timestamps are not strictly increasing at index {index}")]
    OutOfOrder {
        symbol: String,
        timeframe: String,
        index: usize,
    },

    #[error(
        "no detector is configured. The strategy rules are still being defined, so the \
         engine has nothing to run. Register a Detector before starting a backtest."
    )]
    NoDetector,

    #[error("the run was cancelled")]
    Cancelled,

    #[error("{0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

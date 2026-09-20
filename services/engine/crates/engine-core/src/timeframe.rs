use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Timeframes as MT5 names them. The wire codes are stable and written into
/// `.ttb` headers, so never renumber an existing variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Timeframe {
    M1,
    M5,
    M15,
    M30,
    H1,
    H4,
    D1,
    W1,
    MN1,
}

impl Timeframe {
    /// Nominal length in seconds. `MN1` is an approximation — months are not a
    /// fixed length, so never use this to derive a month boundary. It exists
    /// for ordering and for sizing buffers.
    pub const fn seconds(self) -> i64 {
        match self {
            Timeframe::M1 => 60,
            Timeframe::M5 => 300,
            Timeframe::M15 => 900,
            Timeframe::M30 => 1_800,
            Timeframe::H1 => 3_600,
            Timeframe::H4 => 14_400,
            Timeframe::D1 => 86_400,
            Timeframe::W1 => 604_800,
            Timeframe::MN1 => 2_592_000,
        }
    }

    pub const fn code(self) -> u16 {
        match self {
            Timeframe::M1 => 1,
            Timeframe::M5 => 5,
            Timeframe::M15 => 15,
            Timeframe::M30 => 30,
            Timeframe::H1 => 60,
            Timeframe::H4 => 240,
            Timeframe::D1 => 1_440,
            Timeframe::W1 => 10_080,
            Timeframe::MN1 => 43_200,
        }
    }

    pub const fn from_code(code: u16) -> Option<Self> {
        Some(match code {
            1 => Timeframe::M1,
            5 => Timeframe::M5,
            15 => Timeframe::M15,
            30 => Timeframe::M30,
            60 => Timeframe::H1,
            240 => Timeframe::H4,
            1_440 => Timeframe::D1,
            10_080 => Timeframe::W1,
            43_200 => Timeframe::MN1,
            _ => return None,
        })
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Timeframe::M1 => "M1",
            Timeframe::M5 => "M5",
            Timeframe::M15 => "M15",
            Timeframe::M30 => "M30",
            Timeframe::H1 => "H1",
            Timeframe::H4 => "H4",
            Timeframe::D1 => "D1",
            Timeframe::W1 => "W1",
            Timeframe::MN1 => "MN1",
        }
    }
}

impl fmt::Display for Timeframe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Timeframe {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s.to_ascii_uppercase().as_str() {
            "M1" => Timeframe::M1,
            "M5" => Timeframe::M5,
            "M15" => Timeframe::M15,
            "M30" => Timeframe::M30,
            "H1" => Timeframe::H1,
            "H4" => Timeframe::H4,
            "D1" => Timeframe::D1,
            "W1" => Timeframe::W1,
            "MN1" => Timeframe::MN1,
            other => return Err(format!("{other} is not a timeframe")),
        })
    }
}

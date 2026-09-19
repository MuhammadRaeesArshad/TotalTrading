//! The `.ttb` bar file — a flat, columnar, memory-mappable candle store.
//!
//! # Why not read bars from Mongo
//!
//! Ten years of M5 across 28 pairs is roughly 20 million bars. Pulling that
//! through BSON means a document allocation per bar, a parse of every field,
//! and a landing zone of pointer-chasing structs. That parse costs more than
//! the entire simulation it feeds.
//!
//! A `.ttb` file is the same data laid out so the kernel can hand it over for
//! free: `mmap`, cast, iterate. No parse, no allocation, no copy. Mongo keeps
//! what wants querying — strategies, runs, trade logs — and bars live here.
//!
//! # Layout
//!
//! ```text
//! [ 64-byte header ]
//! [ time   : i64 × n ]  (each column padded up to a 64-byte boundary)
//! [ open   : f64 × n ]
//! [ high   : f64 × n ]
//! [ low    : f64 × n ]
//! [ close  : f64 × n ]
//! [ volume : u32 × n ]
//! [ spread : u16 × n ]
//! ```
//!
//! Columnar rather than row-wise for two reasons. A pass that reads only
//! `high` and `low` — which most rolling work does — touches a fraction of the
//! cache lines the row layout would. And each column is a contiguous
//! `&[f64]`, which is what the autovectoriser wants to see.
//!
//! Every column starts on a 64-byte boundary: one cache line, and more than
//! enough to satisfy the alignment of every type stored, so the casts in
//! [`super::bars`] are sound on a page-aligned mapping.

use bytemuck::{Pod, Zeroable};

use crate::timeframe::Timeframe;

pub const MAGIC: [u8; 4] = *b"TTB1";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 64;
pub const ALIGN: usize = 64;

/// Fixed 64-byte file header. `repr(C)` and `Pod`, so it maps directly.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct Header {
    pub magic: [u8; 4],
    pub version: u16,
    pub timeframe_code: u16,
    /// ASCII, NUL-padded. Broker symbols sit well under 16 characters.
    pub symbol: [u8; 16],
    pub count: u64,
    pub first_ts: i64,
    pub last_ts: i64,
    pub flags: u32,
    pub _reserved: [u8; 12],
}

const _: () = assert!(std::mem::size_of::<Header>() == HEADER_LEN);

impl Header {
    pub fn new(
        symbol: &str,
        timeframe: Timeframe,
        count: u64,
        first_ts: i64,
        last_ts: i64,
    ) -> Self {
        let mut sym = [0u8; 16];
        let bytes = symbol.as_bytes();
        let n = bytes.len().min(16);
        sym[..n].copy_from_slice(&bytes[..n]);

        Header {
            magic: MAGIC,
            version: FORMAT_VERSION,
            timeframe_code: timeframe.code(),
            symbol: sym,
            count,
            first_ts,
            last_ts,
            flags: 0,
            _reserved: [0; 12],
        }
    }

    pub fn symbol_str(&self) -> String {
        let end = self.symbol.iter().position(|&b| b == 0).unwrap_or(16);
        String::from_utf8_lossy(&self.symbol[..end]).into_owned()
    }
}

/// Byte offset of each column for a given bar count.
#[derive(Debug, Clone, Copy)]
pub struct Offsets {
    pub time: usize,
    pub open: usize,
    pub high: usize,
    pub low: usize,
    pub close: usize,
    pub volume: usize,
    pub spread: usize,
    pub total: usize,
}

const fn pad(offset: usize) -> usize {
    offset.div_ceil(ALIGN) * ALIGN
}

impl Offsets {
    pub const fn for_count(n: usize) -> Self {
        let time = HEADER_LEN;
        let open = pad(time + n * 8);
        let high = pad(open + n * 8);
        let low = pad(high + n * 8);
        let close = pad(low + n * 8);
        let volume = pad(close + n * 8);
        let spread = pad(volume + n * 4);
        let total = pad(spread + n * 2);

        Offsets { time, open, high, low, close, volume, spread, total }
    }
}

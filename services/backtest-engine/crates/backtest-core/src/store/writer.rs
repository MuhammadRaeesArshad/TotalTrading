//! Builds `.ttb` files. Used by the importer that pulls history out of
//! `mt5-connector` once, so every run after that reads from disk.

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use super::format::{Header, Offsets, ALIGN, HEADER_LEN};
use crate::error::{CoreError, Result};
use crate::timeframe::Timeframe;

/// One bar, as it arrives from the connector. This row-wise shape exists only
/// at the boundary — the writer transposes it into columns.
#[derive(Debug, Clone, Copy)]
pub struct InputBar {
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u32,
    pub spread: u16,
}

/// Writes bars for one symbol and timeframe.
///
/// Writes to `<path>.tmp` and renames on finish. Rename is atomic, so a reader
/// either sees the old complete file or the new one, never a half-written
/// mixture — and an existing mapping keeps pointing at the old inode until it
/// is dropped.
pub fn write_bars(
    path: impl AsRef<Path>,
    symbol: &str,
    timeframe: Timeframe,
    bars: &[InputBar],
) -> Result<PathBuf> {
    let path = path.as_ref().to_path_buf();

    if bars.is_empty() {
        return Err(CoreError::NoBars {
            symbol: symbol.to_string(),
            timeframe: timeframe.to_string(),
        });
    }

    for i in 1..bars.len() {
        if bars[i].time <= bars[i - 1].time {
            return Err(CoreError::OutOfOrder {
                symbol: symbol.to_string(),
                timeframe: timeframe.to_string(),
                index: i,
            });
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let tmp = path.with_extension("ttb.tmp");
    let n = bars.len();
    let off = Offsets::for_count(n);

    let file = fs::File::create(&tmp)?;
    let mut out = BufWriter::with_capacity(1 << 20, file);

    let header = Header::new(
        symbol,
        timeframe,
        n as u64,
        bars[0].time,
        bars[n - 1].time,
    );
    out.write_all(bytemuck::bytes_of(&header))?;

    let mut written = HEADER_LEN;

    // Each column is transposed through a scratch buffer, then written whole.
    // One syscall's worth of work per column rather than per bar.
    macro_rules! column {
        ($target:expr, $ty:ty, $extract:expr) => {{
            pad_to(&mut out, &mut written, $target)?;
            let mut buf: Vec<$ty> = Vec::with_capacity(n);
            buf.extend(bars.iter().map($extract));
            out.write_all(bytemuck::cast_slice(&buf))?;
            written += n * std::mem::size_of::<$ty>();
        }};
    }

    column!(off.time, i64, |b: &InputBar| b.time);
    column!(off.open, f64, |b: &InputBar| b.open);
    column!(off.high, f64, |b: &InputBar| b.high);
    column!(off.low, f64, |b: &InputBar| b.low);
    column!(off.close, f64, |b: &InputBar| b.close);
    column!(off.volume, u32, |b: &InputBar| b.volume);
    column!(off.spread, u16, |b: &InputBar| b.spread);

    // Pad the tail so the mapped length covers every column in full.
    pad_to(&mut out, &mut written, off.total)?;

    out.flush()?;
    out.into_inner()
        .map_err(|e| CoreError::Io(e.into_error()))?
        .sync_all()?;

    fs::rename(&tmp, &path)?;
    Ok(path)
}

fn pad_to<W: Write>(out: &mut W, written: &mut usize, target: usize) -> Result<()> {
    debug_assert!(target >= *written, "columns must be written in order");
    let zeros = [0u8; ALIGN];
    let mut remaining = target - *written;
    while remaining > 0 {
        let chunk = remaining.min(ALIGN);
        out.write_all(&zeros[..chunk])?;
        remaining -= chunk;
    }
    *written = target;
    Ok(())
}

/// Where a symbol and timeframe live inside the bar cache.
pub fn cache_path(root: impl AsRef<Path>, symbol: &str, timeframe: Timeframe) -> PathBuf {
    root.as_ref()
        .join(symbol)
        .join(format!("{}.ttb", timeframe.as_str()))
}

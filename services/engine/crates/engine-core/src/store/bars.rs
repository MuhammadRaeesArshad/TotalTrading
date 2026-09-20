//! Memory-mapped, zero-copy access to a `.ttb` file.

use std::fs::File;
use std::path::{Path, PathBuf};

use memmap2::Mmap;

use super::format::{Header, Offsets, FORMAT_VERSION, HEADER_LEN, MAGIC};
use crate::error::{CoreError, Result};
use crate::timeframe::Timeframe;

/// One symbol on one timeframe, mapped from disk.
///
/// The columns are borrowed views into the mapping — opening a ten-year M5
/// series costs one `mmap` call regardless of how big it is, and pages are
/// faulted in only as the scan actually reaches them.
pub struct Bars {
    _map: Mmap,
    path: PathBuf,
    symbol: String,
    timeframe: Timeframe,
    len: usize,
    // Raw pointers into `_map`. Safety is established once in `open`: the
    // offsets are in bounds, 64-byte aligned, and the mapping outlives them
    // because it is owned by this same struct.
    time: *const i64,
    open: *const f64,
    high: *const f64,
    low: *const f64,
    close: *const f64,
    volume: *const u32,
    spread: *const u16,
}

// The mapping is read-only and never mutated after construction, so sharing a
// `&Bars` across rayon workers is sound.
unsafe impl Send for Bars {}
unsafe impl Sync for Bars {}

impl Bars {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let display = path.display().to_string();
        let file = File::open(&path)?;

        // SAFETY: the caller owns this cache directory. A concurrent writer
        // truncating the file underneath us would be UB, which is why the
        // importer writes to a temp file and renames — rename is atomic, and
        // an existing mapping keeps pointing at the old inode.
        let map = unsafe { Mmap::map(&file)? };

        if map.len() < HEADER_LEN {
            return Err(CoreError::BadMagic { path: display });
        }

        let header: Header = *bytemuck::from_bytes(&map[..HEADER_LEN]);

        if header.magic != MAGIC {
            return Err(CoreError::BadMagic { path: display });
        }
        if header.version != FORMAT_VERSION {
            return Err(CoreError::VersionMismatch {
                path: display,
                found: header.version,
                expected: FORMAT_VERSION,
            });
        }

        let timeframe = Timeframe::from_code(header.timeframe_code).ok_or(
            CoreError::UnknownTimeframe {
                path: display.clone(),
                code: header.timeframe_code,
            },
        )?;

        let len = header.count as usize;
        let off = Offsets::for_count(len);

        if map.len() < off.total {
            return Err(CoreError::Truncated {
                path: display,
                expected: off.total,
                actual: map.len(),
            });
        }

        let base = map.as_ptr();

        // SAFETY: every offset is < off.total <= map.len(), and each is a
        // multiple of 64. `base` is page-aligned, so base+offset satisfies the
        // alignment of i64/f64/u32/u16.
        let bars = unsafe {
            Bars {
                path,
                symbol: header.symbol_str(),
                timeframe,
                len,
                time: base.add(off.time) as *const i64,
                open: base.add(off.open) as *const f64,
                high: base.add(off.high) as *const f64,
                low: base.add(off.low) as *const f64,
                close: base.add(off.close) as *const f64,
                volume: base.add(off.volume) as *const u32,
                spread: base.add(off.spread) as *const u16,
                _map: map,
            }
        };

        bars.validate_ordering()?;
        Ok(bars)
    }

    /// Timestamps must be strictly increasing. Everything downstream — the
    /// alignment map, the no-lookahead guarantee, the bisect helpers — assumes
    /// it, and a duplicated bar from a bad import is silent corruption
    /// otherwise. One linear pass over a column already in cache order.
    fn validate_ordering(&self) -> Result<()> {
        let t = self.time();
        for i in 1..t.len() {
            if t[i] <= t[i - 1] {
                return Err(CoreError::OutOfOrder {
                    symbol: self.symbol.clone(),
                    timeframe: self.timeframe.to_string(),
                    index: i,
                });
            }
        }
        Ok(())
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn symbol(&self) -> &str {
        &self.symbol
    }

    pub fn timeframe(&self) -> Timeframe {
        self.timeframe
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    // SAFETY for all of these: established once in `open`.
    #[inline]
    pub fn time(&self) -> &[i64] {
        unsafe { std::slice::from_raw_parts(self.time, self.len) }
    }
    #[inline]
    pub fn open_px(&self) -> &[f64] {
        unsafe { std::slice::from_raw_parts(self.open, self.len) }
    }
    #[inline]
    pub fn high(&self) -> &[f64] {
        unsafe { std::slice::from_raw_parts(self.high, self.len) }
    }
    #[inline]
    pub fn low(&self) -> &[f64] {
        unsafe { std::slice::from_raw_parts(self.low, self.len) }
    }
    #[inline]
    pub fn close(&self) -> &[f64] {
        unsafe { std::slice::from_raw_parts(self.close, self.len) }
    }
    #[inline]
    pub fn volume(&self) -> &[u32] {
        unsafe { std::slice::from_raw_parts(self.volume, self.len) }
    }
    #[inline]
    pub fn spread(&self) -> &[u16] {
        unsafe { std::slice::from_raw_parts(self.spread, self.len) }
    }

    /// Index of the first bar at or after `ts`. Binary search over a sorted
    /// column — this is how a run narrows to its date range without scanning.
    pub fn index_at_or_after(&self, ts: i64) -> usize {
        self.time().partition_point(|&t| t < ts)
    }

    /// Index of the last bar at or before `ts`, if any.
    pub fn index_at_or_before(&self, ts: i64) -> Option<usize> {
        let p = self.time().partition_point(|&t| t <= ts);
        (p > 0).then(|| p - 1)
    }

    /// Half-open index range `[from, to)` covering `[from_ts, to_ts]`.
    pub fn range(&self, from_ts: i64, to_ts: i64) -> (usize, usize) {
        let start = self.index_at_or_after(from_ts);
        let end = self.time().partition_point(|&t| t <= to_ts);
        (start, end.max(start))
    }

    /// Hint the kernel that this will be read front to back. Turns the scan
    /// from demand paging into readahead, which is most of the difference on a
    /// cold cache.
    pub fn advise_sequential(&self) {
        #[cfg(unix)]
        unsafe {
            libc_madvise(
                self._map.as_ptr() as *mut core::ffi::c_void,
                self._map.len(),
            );
        }
    }
}

#[cfg(unix)]
unsafe fn libc_madvise(addr: *mut core::ffi::c_void, len: usize) {
    // MADV_SEQUENTIAL == 2 on Linux. Declared inline rather than pulling in
    // the whole `libc` crate for one constant and one call.
    extern "C" {
        fn madvise(addr: *mut core::ffi::c_void, length: usize, advice: i32) -> i32;
    }
    const MADV_SEQUENTIAL: i32 = 2;
    let _ = madvise(addr, len, MADV_SEQUENTIAL);
}

impl std::fmt::Debug for Bars {
    /// Deliberately does not print the columns — a ten-year M5 series would
    /// render a hundred megabytes of floats into a panic message.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bars")
            .field("symbol", &self.symbol)
            .field("timeframe", &self.timeframe)
            .field("len", &self.len)
            .field("path", &self.path)
            .finish()
    }
}

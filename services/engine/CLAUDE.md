# Engine — Rust

Anything touching a bar, a price, a fill or money. Detection, simulation,
metrics, the bar cache, history import.

The rules, the service table and where a new file goes are in the root
`CLAUDE.md`. Read that first; this file is only what is specific to here.

## Layout

```
crates/
  engine-core/                no async, no HTTP, no Mongo, no Redis. mmap is the only I/O.
    src/
      lib.rs                  re-exports; the crate's public surface
      error.rs                every error type, one enum
      timeframe.rs
      store/                  the bar cache
        bars.rs               columnar mmap reader
        format.rs             the on-disk .ttb layout
        writer.rs
      engine/
        rolling.rs            reusable primitives — no strategy knowledge
        window.rs             BarCtx, the no-lookahead gate
        align.rs              multi-timeframe mapping
        detector.rs           Detector + DetectorFactory + registry
        strategies/           one module per strategy: smc.rs, smc_mtf.rs, trend_engulf.rs
        structure.rs          shared structure primitives (swings, zones)
        sim.rs                fills, exits, costs
        metrics.rs
        runner.rs             orchestration + rayon
    tests/                    one file per invariant, named after what it protects
    examples/                 throughput.rs and friends
  engine-service/             axum only. No strategy logic, ever.
    src/
      main.rs                 routes + AppState
      jobs.rs                 job queue, progress, cancellation
      importer.rs             pulls history from mt5-connector
      instruments.rs
```

A strategy is a module in `engine/strategies/` implementing `Detector`, registered in the
registry. Anything reusable it needs that is not strategy-specific goes in `structure.rs`
or `rolling.rs` so the next strategy gets it free.

## Conventions

**Rust.** Small types with one job, composed by the caller — follow `rolling.rs`. Detectors
allocate nothing per bar and carry their own state. Public items get a doc comment saying
why, not what. Errors are typed in `error.rs`, never `unwrap()` outside tests. Integration
tests go in `crates/*/tests/`, named after what they protect.

Rust does not build natively on this machine (`rustc` exits `0xC0E90002`).
Run it in Docker — `bash scripts/verify.sh` already does.

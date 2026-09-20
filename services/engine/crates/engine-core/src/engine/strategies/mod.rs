//! Strategies. One module each, every one implementing [`Detector`].
//!
//! A strategy module holds only what is specific to its rules. Anything another
//! rule set could reuse — swings, zones, rolling statistics — belongs in
//! `structure.rs` or `rolling.rs` instead, so it is written once.
//!
//! [`Detector`]: crate::engine::detector::Detector

pub mod smc;
pub mod smc_mtf;

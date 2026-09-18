# ---- build ----
FROM rust:1.83-slim AS build
WORKDIR /build

# Manifests first, so a source-only change doesn't re-download and rebuild
# every dependency. LTO on this workspace is slow; the cache is worth having.
COPY Cargo.toml Cargo.lock ./
COPY crates/backtest-core/Cargo.toml crates/backtest-core/
COPY crates/backtest-service/Cargo.toml crates/backtest-service/
RUN mkdir -p crates/backtest-core/src crates/backtest-service/src \
 && echo "" > crates/backtest-core/src/lib.rs \
 && echo "fn main() {}" > crates/backtest-service/src/main.rs \
 && cargo build --release -p backtest-service \
 && rm -rf crates/backtest-core/src crates/backtest-service/src

COPY crates ./crates
# Touch the real sources so cargo rebuilds them rather than trusting the stubs.
RUN touch crates/backtest-core/src/lib.rs crates/backtest-service/src/main.rs \
 && cargo build --release -p backtest-service

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
RUN useradd -m -u 10001 app
WORKDIR /app

COPY --from=build /build/target/release/backtest-service /usr/local/bin/backtest-service

# The bar cache is mmap'd, so it must be a real filesystem — a volume in
# compose, a PersistentVolumeClaim in k8s. Never bake bars into the image.
ENV BAR_CACHE_DIR=/var/lib/totaltrading/bars PORT=8004
RUN mkdir -p /var/lib/totaltrading/bars && chown -R app:app /var/lib/totaltrading

USER app
EXPOSE 8004
CMD ["backtest-service"]

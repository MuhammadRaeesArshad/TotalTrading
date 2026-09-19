# ---- build ----
FROM rust:1.83-slim AS build
WORKDIR /build

# Manifests first, so a source-only change doesn't re-download and rebuild
# every dependency. LTO on this workspace is slow; the cache is worth having.
COPY Cargo.toml Cargo.lock ./
COPY crates/engine-core/Cargo.toml crates/engine-core/
COPY crates/engine-service/Cargo.toml crates/engine-service/
RUN mkdir -p crates/engine-core/src crates/engine-service/src \
 && echo "" > crates/engine-core/src/lib.rs \
 && echo "fn main() {}" > crates/engine-service/src/main.rs \
 && cargo build --release -p engine-service \
 && rm -rf crates/engine-core/src crates/engine-service/src

COPY crates ./crates
# Touch the real sources so cargo rebuilds them rather than trusting the stubs.
RUN touch crates/engine-core/src/lib.rs crates/engine-service/src/main.rs \
 && cargo build --release -p engine-service

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
RUN useradd -m -u 10001 app
WORKDIR /app

COPY --from=build /build/target/release/engine-service /usr/local/bin/engine-service

# The bar cache is mmap'd, so it must be a real filesystem — a volume in
# compose, a PersistentVolumeClaim in k8s. Never bake bars into the image.
ENV BAR_CACHE_DIR=/var/lib/totaltrading/bars PORT=8004
RUN mkdir -p /var/lib/totaltrading/bars && chown -R app:app /var/lib/totaltrading

USER app
EXPOSE 8004
CMD ["engine-service"]

# Migrations target
FROM docker.io/flyway/flyway:10.7.1 AS migrations
COPY database/ /flyway/
CMD ["migrate"]

# Build stage - builds all Rust binaries
FROM docker.io/rust:1-slim-bookworm AS cargo-build
WORKDIR /src/

# Install build dependencies
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get update && \
    apt-get install -y git libssl-dev pkg-config build-essential && \
    apt-get clean

# Install Rust toolchain components
RUN rustup install stable && \
    rustup default stable

# Copy all source code
COPY . .

# Build all binaries with cache mounts for faster builds
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    CARGO_PROFILE_RELEASE_DEBUG=1 cargo build --release && \
    cp target/release/alerter / && \
    cp target/release/autopilot / && \
    cp target/release/driver / && \
    cp target/release/orderbook / && \
    cp target/release/refunder / && \
    cp target/release/solvers /

# Create a minimal base image for all the binaries
FROM docker.io/debian:bookworm-slim AS base
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get update && \
    apt-get install -y ca-certificates tini gettext-base wget && \
    apt-get clean

# Individual service targets
FROM base AS alerter
COPY --from=cargo-build /alerter /usr/local/bin/alerter
ENTRYPOINT [ "alerter" ]

FROM base AS autopilot
COPY --from=cargo-build /autopilot /usr/local/bin/autopilot
ENTRYPOINT [ "autopilot" ]

FROM base AS driver
COPY --from=cargo-build /driver /usr/local/bin/driver
ENTRYPOINT [ "driver" ]

FROM base AS orderbook
COPY --from=cargo-build /orderbook /usr/local/bin/orderbook
ENTRYPOINT [ "orderbook" ]

FROM base AS refunder
COPY --from=cargo-build /refunder /usr/local/bin/refunder
ENTRYPOINT [ "refunder" ]

FROM base AS solvers
COPY --from=cargo-build /solvers /usr/local/bin/solvers
ENTRYPOINT [ "solvers" ]

# Development target with cargo-watch
FROM docker.io/rust:1-slim-bookworm AS localdev
WORKDIR /src/

# Install development dependencies
RUN apt-get update && \
    apt-get install -y git libssl-dev pkg-config build-essential curl && \
    apt-get clean

# Install Rust components
RUN rustup install stable && \
    rustup default stable && \
    rustup component add clippy rustfmt

# Install cargo-watch for hot reload
RUN cargo install cargo-watch

ENV RUST_BACKTRACE=1

# Extract Binary (combined image with all binaries for debugging)
FROM base
RUN apt-get update && \
    apt-get install -y build-essential cmake git zlib1g-dev libelf-dev libdw-dev libboost-dev libboost-iostreams-dev libboost-program-options-dev libboost-system-dev libboost-filesystem-dev libunwind-dev libzstd-dev && \
    apt-get clean

RUN git clone https://invent.kde.org/sdk/heaptrack.git /heaptrack && \
    mkdir /heaptrack/build && cd /heaptrack/build && \
    cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF .. && \
    make -j$(nproc) && \
    make install && \
    cd / && rm -rf /heaptrack

COPY --from=cargo-build /alerter /usr/local/bin/alerter
COPY --from=cargo-build /autopilot /usr/local/bin/autopilot
COPY --from=cargo-build /driver /usr/local/bin/driver
COPY --from=cargo-build /orderbook /usr/local/bin/orderbook
COPY --from=cargo-build /refunder /usr/local/bin/refunder
COPY --from=cargo-build /solvers /usr/local/bin/solvers
COPY ./entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]

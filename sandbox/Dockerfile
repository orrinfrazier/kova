# Kova sandbox — multi-stage build for isolated code agent execution.
# Pre-installs common language toolchains so agent waves run fast.
#
# Build: docker build --build-arg BASE_IMAGE=node:20-bookworm -t kova-sandbox-<repo>:latest sandbox/
# Run:   docker run --rm -v /path/to/worktree:/workspace kova-sandbox-<repo>:latest

ARG BASE_IMAGE=node:20-bookworm

# ── Stage 1: toolchain install ──────────────────────────────────────
FROM ${BASE_IMAGE} AS toolchain

ENV DEBIAN_FRONTEND=noninteractive

# System packages: git, build tools, curl, common utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    ca-certificates \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# ── TypeScript tooling ──────────────────────────────────────────────
# Node.js comes from the base image; install global tools
RUN npm install -g @biomejs/biome vitest

# ── Rust toolchain ──────────────────────────────────────────────────
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup component add clippy rustfmt

# ── Go toolchain ────────────────────────────────────────────────────
ENV GOPATH=/usr/local/go-packages \
    PATH=/usr/local/go/bin:/usr/local/go-packages/bin:$PATH

RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://go.dev/dl/go1.22.5.linux-${ARCH}.tar.gz" | tar -C /usr/local -xz

# ── Python tooling ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages ruff pytest mypy

# ── Stage 2: runtime ───────────────────────────────────────────────
FROM toolchain AS runtime

# Extra packages placeholder — override via --build-arg or extend
ARG EXTRA_PACKAGES=""
RUN if [ -n "$EXTRA_PACKAGES" ]; then \
      apt-get update && apt-get install -y --no-install-recommends $EXTRA_PACKAGES \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /workspace

# Verify all toolchains are available
RUN node --version \
    && npm --version \
    && git --version \
    && rustc --version \
    && cargo --version \
    && cargo clippy --version \
    && go version \
    && python3 --version \
    && ruff --version \
    && pytest --version \
    && biome --version

CMD ["/bin/bash"]

#!/usr/bin/env bash
# bundle-sidecar.sh — prepares the self-contained Node server bundle for
# the Tauri desktop app before `cargo tauri build` runs.
#
# Outputs:
#   src-tauri/binaries/node-aarch64-apple-darwin   — Node runtime binary
#   src-tauri/resources/server/                     — compiled server + node_modules
#
# Requirements: pnpm installed, Node 23+ available, jq (optional).
# Run from repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_TRIPLE="aarch64-apple-darwin"
BINARIES_DIR="src-tauri/binaries"
RESOURCES_DIR="src-tauri/resources/server"

echo "==> bundle-sidecar: building TypeScript..."
pnpm build

echo "==> bundle-sidecar: setting up bundle dirs..."
mkdir -p "$BINARIES_DIR"
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR"

# ── 1. Copy Node binary ────────────────────────────────────────────────────
NODE_BIN="$(which node)"
ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "ERROR: expected arm64 Mac, got $ARCH" >&2
  exit 1
fi

echo "==> bundle-sidecar: copying node binary from $NODE_BIN..."
cp "$NODE_BIN" "$BINARIES_DIR/node-$TARGET_TRIPLE"
chmod +x "$BINARIES_DIR/node-$TARGET_TRIPLE"
echo "    node binary: $(ls -lh "$BINARIES_DIR/node-$TARGET_TRIPLE" | awk '{print $5}')"

# ── 2. Copy compiled server + core dist ───────────────────────────────────
echo "==> bundle-sidecar: copying server dist..."
mkdir -p "$RESOURCES_DIR/packages/server"
mkdir -p "$RESOURCES_DIR/packages/core"
mkdir -p "$RESOURCES_DIR/packages/cli"

cp -r packages/server/dist "$RESOURCES_DIR/packages/server/dist"
cp    packages/server/package.json "$RESOURCES_DIR/packages/server/package.json"
cp -r packages/core/dist "$RESOURCES_DIR/packages/core/dist"
cp    packages/core/package.json "$RESOURCES_DIR/packages/core/package.json"

# ── 3. Build minimal node_modules for production runtime ──────────────────
# We create a temporary package.json that lists only the server's runtime
# dependencies, install them into the resources dir, then copy native .node
# files to the right slots. This avoids shipping the entire pnpm store.
echo "==> bundle-sidecar: assembling runtime node_modules..."

PNPM_STORE="node_modules/.pnpm"

SERVER_NM="$RESOURCES_DIR/packages/server/node_modules"
mkdir -p "$SERVER_NM"

# Helper: copy a pnpm package into the target node_modules
copy_pkg() {
  local pkg_glob="$1"
  local target_path="$2"
  local src
  src="$(ls -d "$PNPM_STORE/$pkg_glob"/node_modules/* 2>/dev/null | head -1)" || true
  if [[ -z "$src" ]]; then
    echo "  WARN: $pkg_glob not found in pnpm store" >&2
    return
  fi
  mkdir -p "$(dirname "$target_path")"
  cp -r "$src" "$target_path"
}

# better-sqlite3 (includes native .node binary)
BSQLITE_SRC="$(ls -d "$PNPM_STORE/better-sqlite3@"*/node_modules/better-sqlite3 2>/dev/null | head -1)"
if [[ -z "$BSQLITE_SRC" ]]; then
  echo "ERROR: better-sqlite3 not found in pnpm store" >&2; exit 1
fi
echo "    copying better-sqlite3 from $BSQLITE_SRC..."
mkdir -p "$SERVER_NM/better-sqlite3"
cp -r "$BSQLITE_SRC/." "$SERVER_NM/better-sqlite3/"

# bindings module (used by better-sqlite3 to locate the .node file)
BINDINGS_SRC="$(ls -d "$PNPM_STORE/bindings@"*/node_modules/bindings 2>/dev/null | head -1)"
if [[ -n "$BINDINGS_SRC" ]]; then
  echo "    copying bindings from $BINDINGS_SRC..."
  mkdir -p "$SERVER_NM/bindings"
  cp -r "$BINDINGS_SRC/." "$SERVER_NM/bindings/"
fi

# file-uri-to-path (bindings dependency)
FILE_URI_SRC="$(ls -d "$PNPM_STORE/file-uri-to-path@"*/node_modules/file-uri-to-path 2>/dev/null | head -1)"
if [[ -n "$FILE_URI_SRC" ]]; then
  echo "    copying file-uri-to-path..."
  mkdir -p "$SERVER_NM/file-uri-to-path"
  cp -r "$FILE_URI_SRC/." "$SERVER_NM/file-uri-to-path/"
fi

# @node-rs/argon2 (platform-specific bundle)
ARGON2_PLATFORM_SRC="$(ls -d "$PNPM_STORE/@node-rs+argon2-darwin-arm64@"*/node_modules/@node-rs/argon2-darwin-arm64 2>/dev/null | head -1)"
ARGON2_SRC="$(ls -d "$PNPM_STORE/@node-rs+argon2@"*/node_modules/@node-rs/argon2 2>/dev/null | head -1)"
if [[ -n "$ARGON2_SRC" ]]; then
  echo "    copying @node-rs/argon2..."
  mkdir -p "$SERVER_NM/@node-rs/argon2"
  cp -r "$ARGON2_SRC/." "$SERVER_NM/@node-rs/argon2/"
fi
if [[ -n "$ARGON2_PLATFORM_SRC" ]]; then
  echo "    copying @node-rs/argon2-darwin-arm64..."
  mkdir -p "$SERVER_NM/@node-rs/argon2-darwin-arm64"
  cp -r "$ARGON2_PLATFORM_SRC/." "$SERVER_NM/@node-rs/argon2-darwin-arm64/"
fi

# @hono/node-server + hono
for pkg in "hono" "@hono+node-server@"*; do
  SRC="$(ls -d "$PNPM_STORE/$pkg"/node_modules/* 2>/dev/null | head -1)" || true
  if [[ -n "$SRC" ]]; then
    PKG_NAME="$(basename "$SRC")"
    PKG_SCOPE="$(basename "$(dirname "$SRC")")"
    if [[ "$PKG_SCOPE" == node_modules ]]; then
      # unscoped package
      echo "    copying $PKG_NAME..."
      mkdir -p "$SERVER_NM/$PKG_NAME"
      cp -r "$SRC/." "$SERVER_NM/$PKG_NAME/"
    else
      echo "    copying $PKG_SCOPE/$PKG_NAME..."
      mkdir -p "$SERVER_NM/$PKG_SCOPE/$PKG_NAME"
      cp -r "$SRC/." "$SERVER_NM/$PKG_SCOPE/$PKG_NAME/"
    fi
  fi
done

# hono (direct)
HONO_SRC="$(ls -d "$PNPM_STORE/hono@"*/node_modules/hono 2>/dev/null | head -1)"
if [[ -n "$HONO_SRC" ]]; then
  echo "    copying hono..."
  mkdir -p "$SERVER_NM/hono"
  cp -r "$HONO_SRC/." "$SERVER_NM/hono/"
fi

# @hono/node-server
HONO_NODE_SRC="$(ls -d "$PNPM_STORE/@hono+node-server@"*/node_modules/@hono/node-server 2>/dev/null | head -1)"
if [[ -n "$HONO_NODE_SRC" ]]; then
  echo "    copying @hono/node-server..."
  mkdir -p "$SERVER_NM/@hono/node-server"
  cp -r "$HONO_NODE_SRC/." "$SERVER_NM/@hono/node-server/"
fi

# smol-toml
SMOL_SRC="$(ls -d "$PNPM_STORE/smol-toml@"*/node_modules/smol-toml 2>/dev/null | head -1)"
if [[ -n "$SMOL_SRC" ]]; then
  echo "    copying smol-toml..."
  mkdir -p "$SERVER_NM/smol-toml"
  cp -r "$SMOL_SRC/." "$SERVER_NM/smol-toml/"
fi

# zod
ZOD_SRC="$(ls -d "$PNPM_STORE/zod@"*/node_modules/zod 2>/dev/null | head -1)"
if [[ -n "$ZOD_SRC" ]]; then
  echo "    copying zod..."
  mkdir -p "$SERVER_NM/zod"
  cp -r "$ZOD_SRC/." "$SERVER_NM/zod/"
fi

# @agentcapabilityruntime/core, @agentcapabilityruntime/schema
for pkg in "@agentcapabilityruntime+core@"* "@agentcapabilityruntime+schema@"*; do
  SRC="$(ls -d "$PNPM_STORE/$pkg"/node_modules/@agentcapabilityruntime/* 2>/dev/null | head -1)" || true
  if [[ -n "$SRC" ]]; then
    PKG_NAME="$(basename "$SRC")"
    echo "    copying @agentcapabilityruntime/$PKG_NAME..."
    mkdir -p "$SERVER_NM/@agentcapabilityruntime/$PKG_NAME"
    cp -r "$SRC/." "$SERVER_NM/@agentcapabilityruntime/$PKG_NAME/"
  fi
done

# @heybeaux/lattice-* packages
for pkg in "@heybeaux+lattice-adapter-parliament@"* "@heybeaux+lattice-core@"*; do
  SRC="$(ls -d "$PNPM_STORE/$pkg"/node_modules/@heybeaux/* 2>/dev/null | head -1)" || true
  if [[ -n "$SRC" ]]; then
    PKG_NAME="$(basename "$SRC")"
    echo "    copying @heybeaux/$PKG_NAME..."
    mkdir -p "$SERVER_NM/@heybeaux/$PKG_NAME"
    cp -r "$SRC/." "$SERVER_NM/@heybeaux/$PKG_NAME/"
  fi
done

# ── 4. Wire @parliament/core symlink inside server's node_modules ──────────
# Server references @parliament/core as a workspace dep; in the bundle it
# lives at packages/core. We create a relative symlink so Node resolves it.
echo "==> bundle-sidecar: linking @parliament/core..."
mkdir -p "$SERVER_NM/@parliament"
# Relative to $SERVER_NM/@parliament/core -> ../../core/dist
ln -sfn "../../../core" "$SERVER_NM/@parliament/core"

# ── 5. Create server package.json pointing to the right main entry ─────────
# Already copied above; just verify it exists
echo "==> bundle-sidecar: verifying package.json..."
ls "$RESOURCES_DIR/packages/server/package.json" > /dev/null

# ── 6. Summary ────────────────────────────────────────────────────────────
echo ""
echo "==> bundle-sidecar: DONE"
echo "    node binary:    $BINARIES_DIR/node-$TARGET_TRIPLE ($(ls -lh "$BINARIES_DIR/node-$TARGET_TRIPLE" | awk '{print $5}'))"
echo "    server bundle:  $RESOURCES_DIR ($(du -sh "$RESOURCES_DIR" | awk '{print $1}'))"
echo ""
echo "    .node files bundled:"
find "$RESOURCES_DIR" -name "*.node" -exec echo "      {}" \;

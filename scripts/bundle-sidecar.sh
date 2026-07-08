#!/usr/bin/env bash
# bundle-sidecar.sh — prepares the self-contained Node server bundle for
# the Tauri desktop app before `cargo tauri build` runs.
#
# Outputs:
#   src-tauri/binaries/node-aarch64-apple-darwin   — Node runtime binary (arm64)
#   src-tauri/resources/server/                     — compiled server + node_modules
#
# Run from repo root. Requires: pnpm, npm (8+), node (arm64).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_TRIPLE="aarch64-apple-darwin"
BINARIES_DIR="src-tauri/binaries"
RESOURCES_DIR="src-tauri/resources/server"
PNPM_STORE="node_modules/.pnpm"

# ── 0. Sanity checks ──────────────────────────────────────────────────────
ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "ERROR: expected arm64 Mac, got $ARCH. Only arm64 bundles are supported." >&2
  exit 1
fi

NODE_BIN="$(which node)"
NODE_VER="$(node --version)"
echo "==> bundle-sidecar: node $NODE_VER at $NODE_BIN"

# ── 1. Build TypeScript ────────────────────────────────────────────────────
echo "==> bundle-sidecar: building TypeScript..."
pnpm build

# ── 2. Setup output directories ───────────────────────────────────────────
echo "==> bundle-sidecar: setting up output directories..."
mkdir -p "$BINARIES_DIR"
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR/packages/server"
mkdir -p "$RESOURCES_DIR/packages/core"

# ── 3. Copy node binary ───────────────────────────────────────────────────
echo "==> bundle-sidecar: copying node binary..."
cp "$NODE_BIN" "$BINARIES_DIR/node-$TARGET_TRIPLE"
chmod +x "$BINARIES_DIR/node-$TARGET_TRIPLE"

# ── 4. Copy compiled server + core dist ──────────────────────────────────
echo "==> bundle-sidecar: copying server + core dist..."
cp -r packages/server/dist  "$RESOURCES_DIR/packages/server/dist"
cp    packages/server/package.json "$RESOURCES_DIR/packages/server/package.json"
cp -r packages/core/dist    "$RESOURCES_DIR/packages/core/dist"
cp    packages/core/package.json   "$RESOURCES_DIR/packages/core/package.json"

# ── 4b. Bundle the OpenRouter-default desktop config ──────────────────────
# Ships as `parliament.toml` at the resource root. The Tauri sidecar points
# PARLIAMENT_CONFIG at this absolute path so the server resolves it regardless
# of cwd (there's no repo root inside the .app). The OpenRouter API key is NOT
# in this file — it's supplied at runtime via the Settings panel.
echo "==> bundle-sidecar: bundling desktop OpenRouter config..."
cp parliament.desktop.toml "$RESOURCES_DIR/parliament.toml"

# ── 5. Install public runtime deps via npm ────────────────────────────────
# This gets better-sqlite3 (with native rebuild), @node-rs/argon2, hono, etc.
# npm compiles better-sqlite3 against the current node's ABI.
echo "==> bundle-sidecar: npm install of public runtime deps..."
TMPNPM="$(mktemp -d)"
trap "rm -rf $TMPNPM" EXIT

cat > "$TMPNPM/package.json" << 'PKGJSON'
{
  "name": "parliament-server-bundle",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@hono/node-server": "2.0.4",
    "@node-rs/argon2": "2.0.2",
    "better-sqlite3": "12.10.0",
    "hono": "4.12.23",
    "smol-toml": "1.6.1",
    "zod": "4.3.6"
  }
}
PKGJSON

(cd "$TMPNPM" && npm install --omit=dev --silent)

# ── 6. Assemble flat node_modules ────────────────────────────────────────
echo "==> bundle-sidecar: assembling node_modules..."
NM="$RESOURCES_DIR/node_modules"
mkdir -p "$NM"

# Copy all packages from npm install (public deps + their transitive closures)
rsync -a "$TMPNPM/node_modules/" "$NM/"

# @parliament/core symlink — points to packages/core in the same resource root
mkdir -p "$NM/@parliament"
cp -rp "$RESOURCES_DIR/packages/core" "$NM/@parliament/core"

# ── 7. Add private/workspace packages from pnpm store ────────────────────
# These packages have workspace: deps in their published npm versions
# (or aren't on the public registry), so we copy from the local pnpm flat store.
# NOTE: pnpm store dirs use + for scoped packages: @foo/bar@1.0 → @foo+bar@1.0

echo "==> bundle-sidecar: adding workspace/private packages from pnpm store..."

pnpm_copy() {
  # Usage: pnpm_copy <pnpm-store-prefix> <inner-package-path>
  # e.g.:  pnpm_copy "@agentcapabilityruntime+core@" "@agentcapabilityruntime/core"
  local prefix="$1"
  local inner="$2"
  local dest="$NM/$inner"

  # Find the versioned directory in pnpm store
  local store_dir
  store_dir="$(ls -d "${PNPM_STORE}/${prefix}"* 2>/dev/null | head -1)"
  if [[ -z "$store_dir" ]]; then
    echo "  WARN: pnpm store entry for '$prefix*' not found" >&2
    return
  fi
  local src="$store_dir/node_modules/$inner"
  if [[ ! -d "$src" ]]; then
    echo "  WARN: $src does not exist in pnpm store" >&2
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cp -rp "$src" "$dest"
  echo "  + $inner"
}

# @agentcapabilityruntime/core and /schema
pnpm_copy "@agentcapabilityruntime+core@" "@agentcapabilityruntime/core"
pnpm_copy "@agentcapabilityruntime+core@" "@agentcapabilityruntime/schema"

# @heybeaux/lattice-core (directory name includes patch hash)
LATTICE_CORE_DIR="$(ls -d "${PNPM_STORE}/@heybeaux+lattice-core@"* 2>/dev/null | head -1)"
if [[ -n "$LATTICE_CORE_DIR" ]]; then
  mkdir -p "$NM/@heybeaux"
  cp -rp "$LATTICE_CORE_DIR/node_modules/@heybeaux/lattice-core" "$NM/@heybeaux/lattice-core"
  echo "  + @heybeaux/lattice-core"
fi

# @heybeaux/lattice-adapter-parliament
pnpm_copy "@heybeaux+lattice-adapter-parliament@" "@heybeaux/lattice-adapter-parliament"

# Transitive deps of the above that npm's install didn't provide (or got wrong version):
#   ajv v8 (agentcapabilityruntime/core needs dist/2020.js which is v8+)
#   json-schema-traverse v1 (ajv v8 requires v1, not v0)
#   ajv-formats, fast-deep-equal, fast-uri, require-from-string (ajv v8 deps)
#   yaml (agentcapabilityruntime/core)
#   ulidx, layerr (lattice-core → ulidx → layerr)

echo "==> bundle-sidecar: adding transitive private deps..."

pnpm_find_and_copy() {
  # Finds a package anywhere in pnpm store and copies if not already present
  local pkg="$1"      # package name e.g. "ajv"
  local dest="$NM/$pkg"

  local src
  src="$(find "$PNPM_STORE" -maxdepth 3 -path "*/node_modules/$pkg" -type d 2>/dev/null | head -1)"
  if [[ -z "$src" ]]; then
    echo "  WARN: $pkg not found anywhere in pnpm store" >&2
    return
  fi

  # Always replace ajv to guarantee we get v8 (npm might have installed v6)
  if [[ "$pkg" == "ajv" ]]; then
    local v8_src
    v8_src="$(ls -d "${PNPM_STORE}/ajv@8."*/node_modules/ajv 2>/dev/null | head -1)"
    if [[ -n "$v8_src" ]]; then
      rm -rf "$dest"
      cp -rp "$v8_src" "$dest"
      echo "  + ajv (v8, forced)"
      return
    fi
  fi

  if [[ ! -d "$dest" ]]; then
    cp -rp "$src" "$dest"
    echo "  + $pkg"
  fi
}

for pkg in ajv ajv-formats fast-deep-equal fast-uri json-schema-traverse require-from-string yaml ulidx layerr; do
  pnpm_find_and_copy "$pkg"
done

# json-schema-traverse: if installed above, ensure it's v1 not v0
JST_VER="$(cat "$NM/json-schema-traverse/package.json" 2>/dev/null | grep '"version"' | tr -d '"version: ,')"
if [[ "${JST_VER:-0}" == 0.* ]]; then
  V1_SRC="$(ls -d "${PNPM_STORE}/json-schema-traverse@1."*/node_modules/json-schema-traverse 2>/dev/null | head -1)"
  if [[ -n "$V1_SRC" ]]; then
    rm -rf "$NM/json-schema-traverse"
    cp -rp "$V1_SRC" "$NM/json-schema-traverse"
    echo "  + json-schema-traverse (upgraded to v1)"
  fi
fi

# ── 8. Verify .node binaries are present and arm64 ───────────────────────
echo ""
echo "==> bundle-sidecar: verifying native modules..."
ARCH_ERR=0
while IFS= read -r -d '' node_file; do
  arch_check="$(file "$node_file")"
  if echo "$arch_check" | grep -q "arm64"; then
    echo "  ✓ $node_file"
  else
    echo "  ✗ WRONG ARCH: $node_file — $arch_check" >&2
    ARCH_ERR=1
  fi
done < <(find "$NM" -name "*.node" -print0)

if [[ $ARCH_ERR -ne 0 ]]; then
  echo "ERROR: native module arch mismatch — re-run on an arm64 Mac" >&2
  exit 1
fi

# ── 9. Verify server boots with bundled node ─────────────────────────────
echo ""
echo "==> bundle-sidecar: smoke-testing bundled server..."
BUNDLED_NODE="$BINARIES_DIR/node-$TARGET_TRIPLE"
SERVER_ENTRY="$RESOURCES_DIR/packages/server/dist/index.js"

# Point at the bundled desktop config + openrouter provider so the smoke test
# exercises the exact config the .app ships with. No key is set, so /health
# will report models unreachable — that's fine; we only assert the server
# boots and answers, which proves config resolution + native modules work.
PORT=19399 PARLIAMENT_SERVER_HOST=127.0.0.1 \
  PARLIAMENT_CONFIG="$(cd "$RESOURCES_DIR" && pwd)/parliament.toml" \
  PARLIAMENT_PROVIDER=openrouter \
  "$BUNDLED_NODE" "$SERVER_ENTRY" &
SMOKE_PID=$!

# Server boot time varies (native module load, schema validation); retry for
# up to 30s instead of a fixed sleep to avoid flaky failures.
SMOKE_OK=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:19399/health > /dev/null 2>&1; then
    SMOKE_OK=1
    break
  fi
  sleep 1
done
if [[ "$SMOKE_OK" == "1" ]]; then
  echo "  ✓ Server responded on http://127.0.0.1:19399/health"
else
  echo "  ✗ Server did not respond within 30s — check output above" >&2
fi

kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true

if [[ $SMOKE_OK -eq 0 ]]; then
  echo "ERROR: bundled server smoke test failed" >&2
  exit 1
fi

# ── 10. Summary ──────────────────────────────────────────────────────────
echo ""
echo "==> bundle-sidecar: DONE ✓"
echo "    node binary:   $BINARIES_DIR/node-$TARGET_TRIPLE ($(ls -lh "$BINARIES_DIR/node-$TARGET_TRIPLE" | awk '{print $5}'))"
echo "    server bundle: $RESOURCES_DIR ($(du -sh "$RESOURCES_DIR" | awk '{print $1}'))"
echo "    node_modules:  $(ls "$NM" | wc -l | tr -d ' ') top-level packages"

#!/bin/bash
#
# Bake BYOS contracts (Escrow + TrampolineFactory) into the existing
# anvil-state.json and whitelist the BYOS solver in GPv2Authenticator.
#
# Idempotent: skips deployment if Escrow already exists at the computed address.
#
# Prerequisites:
#   - anvil, cast on PATH (install via foundryup)
#   - Node.js 18+ on PATH
#   - state/anvil-state.json must exist (run the chain-deployer first)
#
# Usage:
#   ./scripts/byos/deploy-byos-contracts.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_FILE="$REPO_ROOT/state/anvil-state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "Error: $STATE_FILE not found. Run the chain-deployer first."
  exit 1
fi

# --- Constants ---

RPC_URL="http://127.0.0.1:18545"
CREATE2_FACTORY="0x4e59b44847b379578588920cA78FbF26c0B4956C"
GPV2_SETTLEMENT="0x9008D19f58AAbD9eD0D60971565AA8510560ab41"
GPV2_AUTHENTICATOR="0x2c4c28DDBdAc9C5E7055b4C863b72eA0149D8aFE"

# Account map (Anvil default mnemonic)
# 0 = baseline solver (already whitelisted)
# 1 = escrow operator
# 2 = escrow admin
# 3 = BYOS settlement submitter / solver
ACCOUNT_0="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ACCOUNT_1="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
ACCOUNT_2="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
ACCOUNT_3="0x90F79bf6EB2c4f870365E785982E1f101E93b906"
KEY_0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
SALT="0x0000000000000000000000000000000000000000000000000000000000000000"

# --- Start Anvil ---

echo "Starting Anvil on port 18545 with existing state..."
anvil \
  --port 18545 \
  --host 127.0.0.1 \
  --chain-id 1 \
  --gas-limit 30000000 \
  --load-state "$STATE_FILE" \
  --dump-state "$STATE_FILE" \
  --silent &

ANVIL_PID=$!
trap "kill $ANVIL_PID 2>/dev/null || true; wait $ANVIL_PID 2>/dev/null || true" EXIT

for i in $(seq 1 30); do
  if cast rpc eth_blockNumber --rpc-url "$RPC_URL" > /dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 30 ] && { echo "Error: Anvil timeout"; exit 1; }
  sleep 1
done
echo "Anvil is ready."

# --- Build init code ---

ESCROW_BYTECODE=$(node -e "
  const fs = require('fs');
  const a = JSON.parse(fs.readFileSync('$SCRIPT_DIR/artifacts/Escrow.json','utf8'));
  process.stdout.write(a.bytecode?.object ?? a.bytecode);
")

CONSTRUCTOR_ARGS=$(cast abi-encode \
  "constructor(uint48,address,address,address[],uint256,address,string,string)" \
  172800 \
  "$ACCOUNT_2" \
  "$ACCOUNT_1" \
  "[$ACCOUNT_0]" \
  86400 \
  "$GPV2_SETTLEMENT" \
  "BYOS Escrow" \
  "BYOS")

INIT_CODE="${ESCROW_BYTECODE}${CONSTRUCTOR_ARGS#0x}"

# Compute CREATE2 address: keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
INIT_CODE_HASH=$(cast keccak "$INIT_CODE")
PACKED="0xff${CREATE2_FACTORY#0x}${SALT#0x}${INIT_CODE_HASH#0x}"
ADDRESS_HASH=$(cast keccak "$PACKED")
ESCROW_ADDRESS="0x${ADDRESS_HASH:26}"
# Checksum it
ESCROW_ADDRESS=$(cast to-check-sum-address "$ESCROW_ADDRESS")

echo "Computed Escrow address: $ESCROW_ADDRESS"

# --- Deploy Escrow ---

EXISTING_CODE=$(cast code "$ESCROW_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")

if [ "$EXISTING_CODE" != "0x" ] && [ -n "$EXISTING_CODE" ]; then
  echo "Escrow already deployed, skipping."
else
  echo "Deploying Escrow via CREATE2..."
  CALLDATA="${SALT}${INIT_CODE#0x}"
  cast send "$CREATE2_FACTORY" "$CALLDATA" \
    --rpc-url "$RPC_URL" \
    --private-key "$KEY_0" \
    --gas-limit 15000000 \
    > /dev/null

  DEPLOYED_CODE=$(cast code "$ESCROW_ADDRESS" --rpc-url "$RPC_URL")
  if [ "$DEPLOYED_CODE" = "0x" ] || [ -z "$DEPLOYED_CODE" ]; then
    echo "Error: Escrow deployment failed"
    exit 1
  fi
  echo "Escrow deployed."
fi

# Read TrampolineFactory
TRAMPOLINE_FACTORY=$(cast call "$ESCROW_ADDRESS" "TRAMPOLINE_FACTORY()(address)" --rpc-url "$RPC_URL")
echo "TrampolineFactory: $TRAMPOLINE_FACTORY"

# --- Whitelist BYOS solver (account #3) ---

echo "Whitelisting solver $ACCOUNT_3..."
SOLVER_SLOT=$(cast index address "$ACCOUNT_3" 1)
cast rpc anvil_setStorageAt \
  "$GPV2_AUTHENTICATOR" \
  "$SOLVER_SLOT" \
  "0x0000000000000000000000000000000000000000000000000000000000000001" \
  --rpc-url "$RPC_URL" > /dev/null

IS_SOLVER=$(cast call "$GPV2_AUTHENTICATOR" "isSolver(address)(bool)" "$ACCOUNT_3" --rpc-url "$RPC_URL")
if [ "$IS_SOLVER" != "true" ]; then
  echo "Error: Failed to whitelist solver"
  exit 1
fi
echo "Solver whitelisted."

# --- Dump state ---

echo "Stopping Anvil (dumping state)..."
kill -TERM "$ANVIL_PID" 2>/dev/null || true
wait "$ANVIL_PID" 2>/dev/null || true
trap - EXIT
sleep 2

if [ ! -f "$STATE_FILE" ]; then
  echo "Error: State file not found after dump"
  exit 1
fi

STATE_SIZE=$(stat -f%z "$STATE_FILE" 2>/dev/null || stat -c%s "$STATE_FILE" 2>/dev/null)

echo ""
echo "=== BYOS State Baking Complete ==="
echo "State:              $STATE_FILE ($STATE_SIZE bytes)"
echo "Escrow:             $ESCROW_ADDRESS"
echo "TrampolineFactory:  $TRAMPOLINE_FACTORY"
echo "BYOS Solver:        $ACCOUNT_3 (whitelisted)"

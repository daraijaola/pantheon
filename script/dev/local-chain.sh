#!/bin/bash
# DEV ONLY: a private copy of Elysium testnet (anvil fork, localhost only) with PANTHEON deployed and
# seeded, for building and testing the app screens. Uses anvil's public test accounts, never real keys.
set -euo pipefail
cd "$(dirname "$0")/../.."
RPC=http://127.0.0.1:8545
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil test account 0 (public)
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
STAKER=${STAKER:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}         # anvil test account 1

pkill -f "anvil --port 8545" 2>/dev/null || true
sleep 1
nohup anvil --port 8545 --host 127.0.0.1 --fork-url https://testnet-rpc.elysium.kinetiq.xyz --chain-id 99801 >/tmp/anvil.log 2>&1 &
for _ in $(seq 1 30); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 1; done

S() { forge script "$@" --rpc-url $RPC --private-key $K0 --broadcast --slow -q; }
warp() { cast rpc evm_increaseTime "$1" --rpc-url $RPC >/dev/null; cast rpc evm_mine --rpc-url $RPC >/dev/null; }

echo "1/5 deploy";   ATTESTOR=$A0 CURATOR=$A0 GUARDIAN=$A0 WRITE_DEPLOYMENT=true DEPLOYMENT_FILE=deployments/local.json S script/Deploy.s.sol
echo "2/5 coins";    S script/dev/Seed.s.sol --sig "coins()"
warp 266400   # 3 days + 2 hours: the coins are old enough for the basket
echo "3/5 activity"; S script/dev/Seed.s.sol --sig "activity()"
warp 90000    # 1 day + 1 hour: the basket list's 24-hour wait
echo "4/5 settle";   for _ in 1 2 3 4 5 6; do warp 601; S script/dev/Seed.s.sol --sig "settle()"; done
echo "5/5 basket";   S script/dev/Seed.s.sol --sig "basket(address)" "$STAKER"
cast rpc anvil_setBalance "$STAKER" 0x56BC75E2D63100000 --rpc-url $RPC >/dev/null   # 100 test HYPE for gas
echo "ready: $RPC"; cat deployments/local.json

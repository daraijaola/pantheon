# Elysium mainnet launch runbook

**Prepared only. Nothing here has been executed on production.** Broadcasts, bridging, service changes and cutover below require the launch operator's explicit go-ahead tomorrow. Today's proof uses local Anvil state injection and Forge simulation **without --broadcast**.

Scope: chain **99901 / 0x1863d**, native **HYPE**. HyperEVM is **999**, not 99901. Preserve the running testnet checkout, backend state and web slot for rollback.

## 0. Hard gates, sources and unknowns

All values below marked TODO are deliberately unpublished/unverified. Never substitute a testnet address or guess an endpoint. The canonical public file is `deployments/elysium-mainnet.json`; private provider credentials go in server environment files only.

| Input | Source / action |
|---|---|
| `network.publicRpc` | **TODO** official @Enter_Elysium launch announcement / linked network docs. Independently call eth_chainId and require 99901. No API keys in this browser-visible URL. |
| `network.explorerUrl, explorerApi, creationExplorer` | **TODO** official Elysium explorer links and API docs; check 99901 and contract creation lookups. |
| `network.archiveRpc` | **TODO** published public historical RPC, if available. Otherwise obtain an approved public profile value and put the private archive/simulation endpoint only in ARCHIVE_RPC / DELPHI_HEAVY_RPC. Do not publish an Alchemy key. |
| Private ELYSIUM_RPC | **TODO** operator's provisioned server RPC. User-supplied Alchemy shape: `https://elysium-mainnet.g.alchemy.com/v2/{KEY}`; secret server-side only. Confirm logs, archive reads, eth_simulateV1/debug APIs needed by readers. |
| Root launchpad, usdc, burnSink; external ascendLaunchpad/ascendRouter/usdc | **TODO** @AscendLaunch's official **99901** deployment list and verified source/ABIs. Root/external identities must agree. Confirm USDC decimals=6, launch allowed, baseQuote, poolManager and vault; inspect their code. Burn sink must be the approved immutable sink, not an invented EOA. |
| WHYPE, Multicall3; Kalos/PerpMe contracts, APIs and start blocks | **TODO** each venue's official mainnet deployment manifest/announcement (@kalosfun, @perpmefun), plus explorer creation receipts. Do not assume testnet V3/Infinity ABIs match a newly announced V4 venue. API responses must identify 99901. Current scanner/explainer/X adapters fail closed if their current dependencies are absent. |
| `network.ascendFromBlock`, venue from/factory blocks | **TODO** official external-contract creation receipts, not PANTHEON's deployment block. |
| `network.baseTokens, perpmeQuotes` | **TODO** approved mainnet base-token identities from each venue. Different wrapped-HYPE implementations must remain distinct. |
| `network.acquireUrl` | **TODO** official Ascend buy-page URL for the **newly deployed PNTH**, after its pool exists; verify token/pool identity. |
| Contract fields, `network.deployedFrom` | Produced by deployment below; start block is **TODO** minimum of the six successful deployment receipts. Script preserves the network block; fill start block explicitly afterward. |
| Known hubs/contracts/generic labels | **TODO** verified mainnet identities, or leave optional maps null. Legacy PerpMe oldLaunchFactory/oldLocker may remain null. Do not import testnet faucet labels. |
| Official HYPE bridge URL, canonical bridge contracts, fees, limits and finality | **TODO** @Enter_Elysium's official launch announcement / linked bridge docs, cross-checked from HyperEVM's official ecosystem directory. Not guessed here. Do not use unrelated Elysium/Vulcan Forged documentation. |
| Explorer verifier type, API URL, API credential if required | **TODO** official Elysium/Conduit explorer docs confirming **99901** support. Local Foundry reported “etherscan config not found” and Sourcify “chain not supported”; automatic verification is NOT proven. |
| Release SHA, approved funding budget, key-file locations, service secret-file paths | **TODO** approved phase-3 commit / operator's existing secret inventory, never pasted into chat or this document. |

**No-go:** wrong RPC chain, missing dependency code, wrong base quote/ABI, wrong role/fee policy, unexplained nonce changes, inadequate gas balance, unsupported verification without an approved alternative, or null fields required by the web/services.

Canonical manifests contain public metadata only. Do not log complete environment files, keys, signed transaction bundles or Foundry's sensitive cache.

## 1. Operator workstation: pin inputs and fund the chosen address

Work from the approved branch/commit, not a production checkout. Foundry v1.9.0 and solc 0.8.30 were used for the local proof.

```bash
set -euo pipefail
set +x
set +o history
umask 077
cd /home/ubuntu/repos/pantheon
export SHA=TODO_APPROVED_PHASE3_COMMIT
test "$SHA" != TODO_APPROVED_PHASE3_COMMIT
test "$(git rev-parse HEAD)" = "$SHA"
git submodule update --init --recursive
forge --version
anvil --version
export DEPLOYMENT_FILE="$PWD/deployments/elysium-mainnet.json"
export DEPLOYER_ADDRESS=0xdf6aA48D464d9BC2443096f03cba4Fa750d3bdC6
export TEAM="$DEPLOYER_ADDRESS" CURATOR="$DEPLOYER_ADDRESS"
export GUARDIAN="$DEPLOYER_ADDRESS" ATTESTOR="$DEPLOYER_ADDRESS"
export TEAM_BPS=1500 MAX_RUN_CAP=1000000000 MAX_STALE=172800
export PNTH_NAME=PANTHEON PNTH_SYMBOL=PNTH PNTH_SALT=pantheon-v1
export DEPLOYER_KEY_FILE=TODO_EXISTING_APPROVED_ROLE_KEY_FILE
export RPC_URL_FILE=TODO_PRIVATE_MAINNET_RPC_URL_FILE
test -r "$DEPLOYER_KEY_FILE" && test -r "$RPC_URL_FILE"
# Files must be owner-only; inspect permissions, never their contents.
test "$(stat -c %a "$DEPLOYER_KEY_FILE")" = 600
DEPLOYER_KEY="$(< "$DEPLOYER_KEY_FILE")"
ETH_RPC_URL="$(< "$RPC_URL_FILE")"
export DEPLOYER_KEY ETH_RPC_URL
# Forge v1.9 needs this config variable; ETH_RPC_URL alone does not select its fork.
export FOUNDRY_ETH_RPC_URL="$ETH_RPC_URL"
test "$(cast chain-id)" = 99901
export EXPECTED_NONCE="$(cast nonce "$DEPLOYER_ADDRESS")"
export MIN_DEPLOYER_BALANCE_WEI=TODO_APPROVED_NONZERO_WEI_BUDGET
```

Fill the public manifest from the sources in §0, including root launchpad/usdc/burnSink and the corresponding external identities. Leave not-yet-created PANTHEON contract fields null. Do not use environment-only external overrides for the final release: services and the browser also need the published identities in the manifest.

**Bridge HYPE:** open only the official verified bridge URL once published (TODO source above). Connect the wallet controlling **0xdf6a…bdC6** on **HyperEVM 999**, select native HYPE → **Elysium 99901**, recipient exactly **0xdf6aA48D464d9BC2443096f03cba4Fa750d3bdC6**. Check token identity, fees, minimum, destination gas behavior and quoted finality. Keep HYPE for HyperEVM gas. Send a small approved test amount first; wait for canonical completion and independently confirm destination native balance on the 99901 RPC/explorer before bridging the remainder. Never bridge to a guessed contract/address, use a testnet faucet, or treat a wrapped token as native gas.

The required amount is **TODO** actual mainnet simulation gas × current fee ceiling plus an approved margin and operating gas. Local mock-dependency gas is NOT a mainnet budget. The shared key must remain idle: keeper/relayer live transactions must not compete with this six-transaction deployment.

## 2. Read-only preflight, simulation, then launch-day broadcast

```bash
# No broadcast, no manifest writes:
node script/preflight-mainnet.mjs
# Review role addresses, 15%, cap, staleness, balance, nonce and predicted IndexVault.
# Any nonce warning: STOP, identify intervening activity, rerun simulation and consciously
# update EXPECTED_NONCE. Never blindly accept a changed nonce.
WRITE_DEPLOYMENT=false forge script script/Deploy.s.sol:Deploy
```

Read the mainnet estimate, update the approved nonzero MIN_DEPLOYER_BALANCE_WEI budget, bridge additional HYPE if necessary, rerun preflight, and compare the six planned transactions. No dev-buy is funded. The order remains Passport → CovenantFactory → PNTH launch/router → constituent registry → staking → IndexVault. At initial nonce N, the vault is CREATE(N+5); inside the script after the first two transactions it remains currentNonce+3.

**Only with explicit launch authorization:**

```bash
test "$(cast chain-id)" = 99901
test "$(cast nonce "$DEPLOYER_ADDRESS")" = "$EXPECTED_NONCE"
node script/preflight-mainnet.mjs
cp "$DEPLOYMENT_FILE" "$DEPLOYMENT_FILE.before-launch"
WRITE_DEPLOYMENT=true forge script script/Deploy.s.sol:Deploy --broadcast --slow
# Do not use --skip-simulation. Do not rerun/resume a partial deployment blindly.
# Retain broadcast/cache files privately; never git-add them.
```

On any partial failure, stop. Inspect individual transaction receipts/nonces and creator-role handoff; reconcile the actual deployed graph with the predicted vault and immutable fee targets before choosing recovery. A new run would create another graph and cannot repair an already-immutable wrong fee target.

Verify the six receipts, then derive the event start block:

```bash
python3 - <<'PY'
import json, os
from pathlib import Path
p=Path(os.environ["DEPLOYMENT_FILE"])
bundle=json.loads(Path("broadcast/Deploy.s.sol/99901/run-latest.json").read_text())
receipts=bundle["receipts"]
assert len(receipts)==6, "expected six mined deployment receipts"
number=lambda x:int(x,0) if isinstance(x,str) else x
assert all(number(r["status"])==1 for r in receipts)
blocks=[number(r["blockNumber"]) for r in receipts]
d=json.loads(p.read_text())
assert d["chainId"]==99901
d["network"]["deployedFrom"]=min(blocks)
p.write_text(json.dumps(d,indent=2)+"\n")
print("PASS six successful receipts; deployment start block",min(blocks))
PY
```

Set the actual acquireUrl, confirm every contract has code and read back curator/guardian/attestor, immutable dependencies and fee legs. Compare team 1500 / remaining 8500 on BOTH sides and the vault target with the predicted address. Save the public final manifest and receipt summary with the approved SHA.

## 3. Explorer verification — required TODO gate, not assumed available

Obtain `VERIFY_TYPE` (etherscan/blockscout/sourcify), `VERIFY_URL` and any required API credential from the official explorer operator. Provision any API credential as a secret environment variable, never a CLI literal. Foundry's default Sourcify route did not support 99901 in this preparation.

```bash
export VERIFY_TYPE=TODO_OFFICIAL_VERIFIER_TYPE VERIFY_URL=TODO_OFFICIAL_VERIFIER_API_URL
test "$VERIFY_TYPE" != TODO_OFFICIAL_VERIFIER_TYPE
test "$VERIFY_URL" != TODO_OFFICIAL_VERIFIER_API_URL
eval "$(python3 - <<'PY'
import json,os,shlex
d=json.load(open(os.environ["DEPLOYMENT_FILE"]))
for env,key in {"PP":"passportRegistry","FACTORY":"covenantFactory","PNTH":"pnth","POOL":"pnthPool","ROUTER":"pnthRouter","REGISTRY":"constituentRegistry","STAKING":"staking","INDEX":"indexVault","LP":"launchpad","USDC":"usdc","SINK":"burnSink"}.items():
 v=d[key]; assert isinstance(v,str) and v.startswith("0x")
 print("export "+env+"="+shlex.quote(v))
PY
)"
verify() {
  forge verify-contract "$1" "$2" --chain 99901 --watch \
    --verifier "$VERIFY_TYPE" --verifier-url "$VERIFY_URL" --constructor-args "$3"
}
verify "$PP" src/passport/HypePassportRegistry.sol:HypePassportRegistry \
  "$(cast abi-encode 'constructor(address,address)' "$ATTESTOR" "$GUARDIAN")"
verify "$FACTORY" src/covenant/CovenantFactory.sol:CovenantFactory \
  "$(cast abi-encode 'constructor(address,address)' "$LP" "$SINK")"
verify "$REGISTRY" src/index/ConstituentRegistry.sol:ConstituentRegistry \
  "$(cast abi-encode 'constructor(address,address,address,address,address,uint128)' "$LP" "$USDC" "$PNTH" "$CURATOR" "$GUARDIAN" "$MAX_RUN_CAP")"
verify "$STAKING" src/staking/PantheonStaking.sol:PantheonStaking \
  "$(cast abi-encode 'constructor(address,address,address)' "$PNTH" "$PP" "$REGISTRY")"
verify "$INDEX" src/index/IndexVault.sol:IndexVault \
  "$(cast abi-encode 'constructor(address,address,address,uint256)' "$LP" "$REGISTRY" "$STAKING" "$MAX_STALE")"
ZERO=0x0000000000000000000000000000000000000000
verify "$ROUTER" src/covenant/CovenantRouter.sol:CovenantRouter \
  "$(cast abi-encode 'constructor(address,bytes32,address,address,address,(uint8,uint16,address)[],(uint8,uint16,address)[])' \
    "$LP" "$POOL" "$PNTH" "$USDC" "$SINK" \
    "[(1,8500,$ZERO),(0,1500,$TEAM)]" "[(2,8500,$INDEX),(0,1500,$TEAM)]")"
```

PNTH itself is Ascend's token implementation, not a PANTHEON-owned token artifact: **TODO** obtain Ascend's exact factory token source/compiler/constructor metadata and verify it through their documented path. Check matching runtime bytecode, not merely an explorer label. Save each successful verification URL. If the new explorer cannot verify yet, stop for an explicit release decision; do not claim verification passed.

## 4. Package an isolated release; keep production Git untouched

From the workstation, archive the approved code and separately attach the completed PUBLIC manifest. The archive's tracked manifest is still the null template; the explicit overlay below is mandatory.

```bash
export WORK="$HOME/mainnet-release-$SHA"
mkdir -p "$WORK"
git archive --format=tar "$SHA" > "$WORK/release.tar"
cp "$DEPLOYMENT_FILE" "$WORK/mainnet.json"
(cd "$WORK" && sha256sum release.tar mainnet.json > SHA256SUMS)
ssh -i /home/ubuntu/.ssh/pantheon_vps micheal@169.58.113.104 \
  'mkdir -p /home/micheal/mainnet-staging'
scp -i /home/ubuntu/.ssh/pantheon_vps \
  "$WORK/release.tar" "$WORK/mainnet.json" "$WORK/SHA256SUMS" \
  micheal@169.58.113.104:/home/micheal/mainnet-staging/
```

On the server, use the same approved SHA and Node 24. Do not pull/reset/checkout the old /srv/hackathon/pantheon repository.

```bash
set -euo pipefail
set +x
umask 077
export SHA=TODO_SAME_APPROVED_PHASE3_COMMIT
test "$SHA" != TODO_SAME_APPROVED_PHASE3_COMMIT
export RELEASE="/opt/pantheon-mainnet/releases/$SHA"
export REPO="$RELEASE/repo"
export STATE=/var/lib/pantheon-mainnet/elysium-mainnet
export ENVROOT=/etc/pantheon-mainnet
export NODE_BIN="$(command -v node)"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
(cd /home/micheal/mainnet-staging && sha256sum -c SHA256SUMS)
sudo install -d -o micheal -g "$(id -gn micheal)" "$REPO"
tar -xf /home/micheal/mainnet-staging/release.tar -C "$REPO"
install -m 644 /home/micheal/mainnet-staging/mainnet.json "$REPO/deployments/elysium-mainnet.json"
sudo install -d -m 700 "$ENVROOT"
for svc in indexer keeper passport trials uploaded delphi; do
  (cd "$REPO/services/$svc" && npm ci)
done
(cd "$REPO/web" && npm ci)
```

Every service uses a new release working directory below; NO testnet DB/state/round is copied. Keep the immutable original web working directory and its active .next-a/.next-b slot, BUILD_ID, environment and service configuration. Record them privately before cutover.

## 5. Mainnet environments and parallel backend units

Use **new parallel mainnet units and ports**, leaving testnet services available for rollback. Preserve each original unit's User; record its original complete unit privately with mode 0600. New units do not overwrite old service files. Keep keeper dry and X shadow until final health review.

| Original unit → parallel unit | New WorkingDirectory | Mainnet data / port |
|---|---|---|
| pantheon-indexer → pantheon-indexer-mainnet | $REPO/services/indexer | $STATE/indexer/index.json; 19989 |
| pantheon-passport → pantheon-passport-mainnet | $REPO/services/passport | $STATE/passport/passport.db; 19987 |
| pantheon-trials → pantheon-trials-mainnet | $REPO/services/trials | $STATE/trials/ballots.json, $STATE/trials/rounds; 19990 |
| pantheon-keeper → pantheon-keeper-mainnet | $REPO/services/keeper | $STATE/keeper/state.json; dry |
| pantheon-uploaded → pantheon-uploaded-mainnet | $REPO/services/uploaded | $STATE/uploaded/guard.json and adjacent wallet-reads; 19991 |
| delphi-feed → delphi-feed-mainnet | $REPO/services/delphi | $STATE/delphi/feed.db, disputes.log; 19910 |
| delphi-refresh → delphi-refresh-mainnet | $REPO/services/delphi | $STATE/delphi/delphi.db, out, feed.db; oneshot |
| delphi-x → delphi-x-mainnet | $REPO/services/delphi | $STATE/delphi/x.db, out/x/drafts.jsonl; shadow |
| pantheon-web | $REPO/web, isolated .next-a | compiled mainnet profile; backend URLs below |

Provision these **TODO secret file locations** from the operator's existing secret inventory, not from this report:
- Server mainnet RPC + archive URLs.
- Mainnet role key from the chosen 0xdf6a…bdC6 wallet; install mode 0600 separately for Passport attestor/relayer and keeper under their new private key directories, owned by their service User. Do not accidentally copy an old testnet role key. Keep it out of common.env.
- Fresh mainnet Passport pepper (generate locally with openssl rand -hex 32 into an owner-only file; do not print).
- X_KEYS_FILE and X_CLAUDE_KEY_FILE: existing approved X/Claude files from the old delphi-x unit, readable by its inherited User.
- DELPHI_ANTHROPIC_KEY_FILE: existing approved explainer key file.
- Web SESSION_SECRET, AUTH_ORIGIN, Anthropic/xAI credentials, WalletConnect project ID and any other existing web settings: securely copy the old .env.production.local into the new web release; override chain/upstream/data values as below. Never print the source file.

Create $ENVROOT/common.env as root-only with NETWORK=mainnet, DEPLOYMENT=elysium-mainnet, DEPLOYMENT_FILE=$REPO/deployments/elysium-mainnet.json, NODE_ENV=production and actual private ELYSIUM_RPC, ARCHIVE_RPC, DELPHI_HEAVY_RPC. **TODO** actual URLs from approved secret sources. Do NOT set a global FROM_BLOCK: Delphi uses Ascend's block, indexer/keeper use PANTHEON's block.

The following generates non-secret per-service settings and units. First create common.env securely, and populate the key-file path environment variables below with the approved existing/new files. Systemd reads root-only EnvironmentFile before dropping User privileges.

```bash
export PASSPORT_ROLE_KEY_FILE=TODO_NEW_PASSPORT_OWNED_MAINNET_ROLE_KEY_FILE
export PASSPORT_PEPPER_FILE=TODO_NEW_PASSPORT_OWNED_MAINNET_PEPPER_FILE
export KEEPER_ROLE_KEY_FILE=TODO_NEW_KEEPER_OWNED_MAINNET_ROLE_KEY_FILE
export X_KEYS_FILE=TODO_EXISTING_X_KEYS_FILE
export X_CLAUDE_KEY_FILE=TODO_EXISTING_X_CLAUDE_KEY_FILE
export DELPHI_ANTHROPIC_KEY_FILE=TODO_EXISTING_EXPLAINER_KEY_FILE
for name in PASSPORT_ROLE_KEY_FILE PASSPORT_PEPPER_FILE KEEPER_ROLE_KEY_FILE X_KEYS_FILE X_CLAUDE_KEY_FILE DELPHI_ANTHROPIC_KEY_FILE; do
  test "${!name}" != "TODO_NEW_PASSPORT_OWNED_MAINNET_ROLE_KEY_FILE"
  case "${!name}" in TODO*) echo "STOP: fill $name from secret inventory"; exit 1;; esac
  sudo test -r "${!name}"
done
sudo test -s "$ENVROOT/common.env"
sudo groupadd -f pantheon-mainnet-delphi
sudo env REPO="$REPO" STATE="$STATE" ENVROOT="$ENVROOT" NODE_BIN="$NODE_BIN" \
  PASSPORT_ROLE_KEY_FILE="$PASSPORT_ROLE_KEY_FILE" PASSPORT_PEPPER_FILE="$PASSPORT_PEPPER_FILE" \
  KEEPER_ROLE_KEY_FILE="$KEEPER_ROLE_KEY_FILE" X_KEYS_FILE="$X_KEYS_FILE" \
  X_CLAUDE_KEY_FILE="$X_CLAUDE_KEY_FILE" DELPHI_ANTHROPIC_KEY_FILE="$DELPHI_ANTHROPIC_KEY_FILE" python3 - <<'PY'
import os,json,pwd,grp,subprocess
from pathlib import Path
r,s,e,node=map(os.environ.__getitem__,["REPO","STATE","ENVROOT","NODE_BIN"])
shared={"DB_PATH":s+"/delphi/delphi.db","OUT_DIR":s+"/delphi/out","FEED_DB":s+"/delphi/feed.db"}
settings={
"pantheon-indexer":("indexer","src/server.ts",{"PORT":19989,"STATE_FILE":s+"/indexer/index.json"}),
"pantheon-passport":("passport","src/server.ts",{"PORT":19987,"DB_PATH":s+"/passport/passport.db","ATTESTOR_KEY_FILE":os.environ["PASSPORT_ROLE_KEY_FILE"],"RELAYER_KEY_FILE":os.environ["PASSPORT_ROLE_KEY_FILE"],"PEPPER_FILE":os.environ["PASSPORT_PEPPER_FILE"]}),
"pantheon-trials":("trials","src/server.ts",{"PORT":19990,"STATE_FILE":s+"/trials/ballots.json","ROUNDS_DIR":s+"/trials/rounds"}),
"pantheon-keeper":("keeper","src/main.ts",{"KEEPER_MODE":"dry","STATE_FILE":s+"/keeper/state.json","KEEPER_KEY_FILE":os.environ["KEEPER_ROLE_KEY_FILE"],"PASSPORT_API":"http://127.0.0.1:19987"}),
"pantheon-uploaded":("uploaded","src/server.ts",{**shared,"PORT":19991,"GUARD_FILE":s+"/uploaded/guard.json","SCAN_FILE":s+"/delphi/out/scan.json","INDEXER_URL":"http://127.0.0.1:19989","TRIALS_URL":"http://127.0.0.1:19990","DELPHI_DIR":r+"/services/delphi"}),
"delphi-feed":("delphi","scripts/feed.ts",{**shared,"PORT":19910,"DISPUTE_LOG":s+"/delphi/disputes.log"}),
"delphi-refresh":("delphi","",dict(shared,DELPHI_ANTHROPIC_KEY_FILE=os.environ["DELPHI_ANTHROPIC_KEY_FILE"])),
"delphi-x":("delphi","scripts/x.ts --loop",{**shared,"X_MODE":"shadow","X_STATE":s+"/delphi/x.db","X_DRAFTS":s+"/delphi/out/x/drafts.jsonl","X_KEYS_FILE":os.environ["X_KEYS_FILE"],"X_CLAUDE_KEY_FILE":os.environ["X_CLAUDE_KEY_FILE"]}),
}
group=grp.getgrnam("pantheon-mainnet-delphi").gr_gid
for old,(service,entry,values) in settings.items():
 user=subprocess.check_output(["systemctl","show",old+".service","-p","User","--value"],text=True).strip() or "root"
 uid=pwd.getpwnam(user).pw_uid
 for directory in [Path(s)/service]+([Path(s)/"trials"/"rounds"] if service=="trials" else []):
  directory.mkdir(parents=True,exist_ok=True)
  if directory==Path(s)/"delphi": os.chown(directory,0,group); directory.chmod(0o2770)
  else: os.chown(directory,uid,pwd.getpwnam(user).pw_gid); directory.chmod(0o700)
 env=Path(e)/(old+".env")
 env.write_text("".join(k+"="+json.dumps(str(v))+"\n" for k,v in values.items()))
 env.chmod(0o600)
 oneshot=old=="delphi-refresh"
 command=(node+" scripts/scan.ts\nExecStart="+node+" scripts/explain.ts\nExecStart="+node+" scripts/feed-publish.ts") if oneshot else node+" "+entry
 unit="[Unit]\nDescription=PANTHEON isolated mainnet "+old+"\nAfter=network-online.target\n[Service]\nType="+("oneshot" if oneshot else "simple")+"\nUser="+user+"\nSupplementaryGroups=pantheon-mainnet-delphi\nUMask=0007\nWorkingDirectory="+r+"/services/"+service+"\nEnvironmentFile="+e+"/common.env\nEnvironmentFile="+str(env)+"\nExecStart="+command+"\n"+("" if oneshot else "Restart=on-failure\nRestartSec=5\n")+"[Install]\nWantedBy=multi-user.target\n"
 Path("/etc/systemd/system/"+old+"-mainnet.service").write_text(unit)
Path("/etc/systemd/system/delphi-refresh-mainnet.timer").write_text("[Unit]\nDescription=Mainnet DELPHI refresh\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=15min\nUnit=delphi-refresh-mainnet.service\n[Install]\nWantedBy=timers.target\n")
PY
sudo systemd-analyze verify /etc/systemd/system/*-mainnet.service /etc/systemd/system/delphi-refresh-mainnet.timer
sudo systemctl daemon-reload
```

Review generated configuration privately (names/paths only in shared logs); confirm new service Users can read their respective keys and release files. All shared DELPHI cache/output/feed files must remain group-readable/writable to the new feed/refresh/X/Uploaded processes; private Passport/Uploaded state stays in its private directory. Web gets the same supplemental group when switched.

Before starting anything, run each package's typecheck and canonical profile validation with its mainnet environment, without dumping the environment. All required published venue fields must be filled. Null required Kalos/PerpMe data means **STOP**, not use testnet values or relabel cached data.

## 6. Backend before web; freshness and backups

```bash
sudo systemctl start pantheon-passport-mainnet pantheon-indexer-mainnet pantheon-trials-mainnet
sudo systemctl start delphi-refresh-mainnet
sudo systemctl start delphi-feed-mainnet pantheon-uploaded-mainnet
sudo systemctl start pantheon-keeper-mainnet delphi-x-mainnet
sudo systemctl enable delphi-refresh-mainnet.timer
sudo systemctl start delphi-refresh-mainnet.timer
curl --fail http://127.0.0.1:19987/passport/health
curl --fail http://127.0.0.1:19989/stats
curl --fail http://127.0.0.1:19990/trials/current
curl --fail http://127.0.0.1:19910/v1/health
```

Confirm indexer head approaches mainnet head, Passport registry/attestor match the new contracts, Delphi scan metadata says mainnet, timestamps are fresh, and no old token feed/round/wallet-read state is present. Exercise Uploaded through the authenticated web in the next stage.

**Backup:** create a separate mainnet backup job using $REPO/ops/backup/pantheon-backup.sh with INDEXER_STATE, PASSPORT_DB, TRIALS_STATE, KEEPER_STATE, DELPHI_DB, DELPHI_FEED_DB, DELPHI_X_DB mapped to the table above, REPO_ROOT=$REPO, BACKUP_DIR=/var/backups/pantheon-mainnet and STATUS_FILE=$STATE/ops/backup-status.json. Use the existing backup unit's approved User/tool paths. Run it once and require its restore/quick_check checks succeed; schedule it separately from testnet. Do not point the web at the old testnet backup heartbeat.

Fresh empty mainnet feeds may correctly fail aggregate health. Do not forge data or disable freshness checks to obtain green. If there are no launch-day venue coins, **TODO explicit product/release decision**: wait for real data or ship an independently reviewed truthful degraded-mode change. The current code does not silently waive these gates.

## 7. Build new web slot and blue/green cutover

Securely copy the original web .env.production.local into $REPO/web/.env.production.local without displaying it; keep the original unchanged. Override/append these values in the new file (actual server RPC credential stays server-side):
- NEXT_PUBLIC_DEPLOYMENT=elysium-mainnet
- ELYSIUM_RPC=approved private mainnet RPC
- INDEXER_API=http://127.0.0.1:19989
- PASSPORT_API=http://127.0.0.1:19987
- TRIALS_API=http://127.0.0.1:19990
- UPLOADED_API=http://127.0.0.1:19991
- DELPHI_SITE_JSON=$STATE/delphi/out/site.json
- DELPHI_HEALTH_URL=http://127.0.0.1:19910/v1/health
- BACKUP_STATUS_FILE=$STATE/ops/backup-status.json

Capture the actual old web settings privately and merge secrets without printing them. The operator must confirm this is the currently serving unit. Existing inline/file environment overrides must not silently select testnet in the new release:

```bash
sudo env REPO="$REPO" STATE="$STATE" ENVROOT="$ENVROOT" NODE_BIN="$NODE_BIN" python3 - <<'PY'
import os,json,shlex,re,pwd,subprocess
from pathlib import Path
r,s,e,node=map(os.environ.__getitem__,["REPO","STATE","ENVROOT","NODE_BIN"])
def show(k):
 return subprocess.check_output(["systemctl","show","pantheon-web.service","-p",k,"--value"],text=True).strip()
def load(path):
 code='import {parseEnv} from "node:util"; import {readFileSync} from "node:fs"; console.log(JSON.stringify(parseEnv(readFileSync(process.argv[1],"utf8"))))'
 return json.loads(subprocess.check_output([node,"--input-type=module","-e",code,str(path)],text=True))
old=Path(show("WorkingDirectory")); user=show("User") or "root"
rollback=Path(e)/"rollback"; rollback.mkdir(mode=0o700,exist_ok=True)
meta=rollback/"web-before.json"; assert not meta.exists(),"do not overwrite rollback metadata"
slot=(old/".dist-slot").read_text().strip()
meta.write_text(json.dumps({"directory":str(old),"slot":slot,"buildId":(old/slot/"BUILD_ID").read_text().strip(),"user":user})); meta.chmod(0o600)
unit=rollback/"web-before.unit"
unit.write_bytes(subprocess.check_output(["systemctl","cat","pantheon-web.service"])); unit.chmod(0o600)
values=load(old/".env.production.local")
values.update(dict(x.split("=",1) for x in shlex.split(show("Environment"))))
for path in re.findall(r"(\S+) \(ignore_errors=(?:yes|no)\)",show("EnvironmentFiles")):
 if Path(path).exists(): values.update(load(path))
values.update(load(Path(e)/"common.env"))
values.update({"NEXT_PUBLIC_DEPLOYMENT":"elysium-mainnet","NEXT_DIST_DIR":".next-a","INDEXER_API":"http://127.0.0.1:19989","PASSPORT_API":"http://127.0.0.1:19987","TRIALS_API":"http://127.0.0.1:19990","UPLOADED_API":"http://127.0.0.1:19991","DELPHI_SITE_JSON":s+"/delphi/out/site.json","DELPHI_HEALTH_URL":"http://127.0.0.1:19910/v1/health","BACKUP_STATUS_FILE":s+"/ops/backup-status.json"})
for target in [Path(e)/"web.env",Path(r)/"web"/".env.production.local"]:
 target.write_text("".join(k+"="+json.dumps(str(v))+"\n" for k,v in values.items())); target.chmod(0o600)
 if target.parent.name=="web": os.chown(target,pwd.getpwnam(user).pw_uid,pwd.getpwnam(user).pw_gid)
PY
export WEB_USER="$(systemctl show pantheon-web.service -p User --value)"
test -n "$WEB_USER" || WEB_USER=root
sudo chown -R "$WEB_USER:$(id -gn "$WEB_USER")" "$REPO/web"
```

```bash
# In the NEW release only:
(cd "$REPO/web" && sudo -u "$WEB_USER" env NEXT_DIST_DIR=.next-a npm run build)
printf '.next-a\n' | sudo -u "$WEB_USER" tee "$REPO/web/.dist-slot" >/dev/null
export WEB_USER="$(systemctl show pantheon-web.service -p User --value)"
test -n "$WEB_USER" || WEB_USER=root
export MAINNET_BUILD_ID="$(cat "$REPO/web/.next-a/BUILD_ID")"
sudo systemd-run --unit=pantheon-web-mainnet-warm --property="User=$WEB_USER" \
  --property=SupplementaryGroups=pantheon-mainnet-delphi \
  --property="EnvironmentFile=$ENVROOT/web.env" \
  --working-directory="$REPO/web" --setenv=NODE_ENV=production \
  "$NODE_BIN" node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3001
curl --fail http://127.0.0.1:3001/api/health
curl --fail http://127.0.0.1:3001/
```

Require aggregate ok=true. Browser-check the warm surface with a throwaway **99901** SIWE session, signing only: /upload → /space → Stake/Trials/Passport/DELPHI chat; test logout, owner-only saved reads, wrong-chain switching and mainnet /get buy link. Never use mock transactions or a fake Passport to claim live health.

Use Caddy's existing local admin API for continuity; snapshot the full config privately first. **TODO source:** launch operator confirms the actual admin address is http://127.0.0.1:2019 and 3000 is the current web upstream (as in the previous deployments). If not, stop rather than guessing. Inspect whether any public service routes bypass Next; if so, add their approved old→mainnet port replacements to the same reviewed config change, and include them in rollback. Next-owned /api rewrites already use the built mainnet upstreams.

```bash
sudo install -d -m 700 "$ENVROOT/rollback"
sudo env ENVROOT="$ENVROOT" python3 - <<'PY'
import json,os,urllib.request
from pathlib import Path
base="http://127.0.0.1:2019"
raw=urllib.request.urlopen(base+"/config/").read()
p=Path(os.environ["ENVROOT"])/"rollback"/"caddy-before.json"
assert not p.exists(),"do not overwrite rollback snapshot"
p.write_bytes(raw); p.chmod(0o600)
d=json.loads(raw); changed=[]
def walk(x):
 if isinstance(x,dict):
  if x.get("dial")=="127.0.0.1:3000": x["dial"]="127.0.0.1:3001"; changed.append(True)
  for v in x.values():walk(v)
 elif isinstance(x,list):
  for v in x:walk(v)
walk(d); assert changed,"expected existing web upstream"
urllib.request.urlopen(urllib.request.Request(base+"/load",data=json.dumps(d).encode(),headers={"Content-Type":"application/json"},method="POST")).read()
print("PASS Caddy switched to healthy warm mainnet web")
PY
```

Keep an external HTTP continuity monitor running across both Caddy switches. With traffic on 3001, install ONLY our new drop-in and restart the primary behind the warm listener:

```bash
sudo env REPO="$REPO" ENVROOT="$ENVROOT" NODE_BIN="$NODE_BIN" python3 - <<'PY'
import os
from pathlib import Path
p=Path("/etc/systemd/system/pantheon-web.service.d/90-mainnet.conf")
assert not p.exists(),"do not overwrite an existing drop-in"
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text("[Service]\nWorkingDirectory="+os.environ["REPO"]+"/web\nSupplementaryGroups=pantheon-mainnet-delphi\nEnvironment=\nEnvironmentFile=\nEnvironmentFile="+os.environ["ENVROOT"]+"/web.env\nExecStart=\nExecStart="+os.environ["NODE_BIN"]+" node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000\n")
PY
sudo systemctl daemon-reload
sudo systemctl restart pantheon-web
curl --fail http://127.0.0.1:3000/api/health
sudo python3 - <<'PY'
import json,urllib.request
base="http://127.0.0.1:2019"
d=json.load(urllib.request.urlopen(base+"/config/")); changed=[]
def walk(x):
 if isinstance(x,dict):
  if x.get("dial")=="127.0.0.1:3001":x["dial"]="127.0.0.1:3000";changed.append(True)
  for v in x.values():walk(v)
 elif isinstance(x,list):
  for v in x:walk(v)
walk(d);assert changed
urllib.request.urlopen(urllib.request.Request(base+"/load",data=json.dumps(d).encode(),headers={"Content-Type":"application/json"},method="POST")).read()
PY
# Require public health/served-build attribution before stopping the warm listener.
```

After successful public checks, stop pantheon-web-mainnet-warm. Do not stop it on a failed primary check: route back to healthy 3001 and investigate. Original testnet slots remain untouched.

Before stopping the warm listener, attribute the public response to the new build by matching a unique asset referenced by its HTML byte-for-byte, and verify the public SIWE challenge's chain:

```bash
sudo env REPO="$REPO" ENVROOT="$ENVROOT" NODE_BIN="$NODE_BIN" python3 - <<'PY'
import os,json,re,hashlib,subprocess,urllib.request
from pathlib import Path
r,e,node=map(os.environ.__getitem__,["REPO","ENVROOT","NODE_BIN"])
code='import {parseEnv} from "node:util"; import {readFileSync} from "node:fs"; console.log(JSON.stringify(parseEnv(readFileSync(process.argv[1],"utf8"))))'
values=json.loads(subprocess.check_output([node,"--input-type=module","-e",code,e+"/web.env"],text=True))
site=values["AUTH_ORIGIN"].rstrip("/")
old=json.loads((Path(e)/"rollback"/"web-before.json").read_text())
new=Path(r)/"web"/".next-a"; previous=Path(old["directory"])/old["slot"]
html=urllib.request.urlopen(site+"/").read().decode()
matched=False
for uri in re.findall(r'/_next/static/[^"\s<>]+\.js',html):
 relative=uri.removeprefix("/_next/")
 current=new/relative; prior=previous/relative
 if current.is_file() and (not prior.exists() or prior.read_bytes()!=current.read_bytes()):
  remote=urllib.request.urlopen(site+uri).read()
  assert hashlib.sha256(remote).digest()==hashlib.sha256(current.read_bytes()).digest()
  matched=True; break
assert matched,"public HTML did not reference a unique matching mainnet-build asset"
challenge=json.load(urllib.request.urlopen(site+"/api/auth/nonce"))
assert challenge["chainId"]==99901
print("PASS public unique asset matches isolated BUILD_ID",(new/"BUILD_ID").read_text().strip())
print("PASS public SIWE challenge chainId=99901")
PY
sudo systemctl stop pantheon-web-mainnet-warm
```

This attributes served assets to the saved BUILD_ID without assuming Next exposes a BUILD_ID header. A failed match or wrong chain is a no-go, not permission to stop the rollback listener.

## 8. Final health, timers and first Trials round

Public final check (set SITE from the existing AUTH_ORIGIN, never guess a domain):

```bash
export SITE=TODO_EXISTING_CANONICAL_AUTH_ORIGIN
test "$SITE" != TODO_EXISTING_CANONICAL_AUTH_ORIGIN
curl --fail "$SITE/api/health"
curl --fail "$SITE/api/auth/nonce"
# Repeat throwaway SIWE navigation above; record timings, zero owned 5xx/exceptions.
```

Check owner-only reads with two sessions; ensure mainnet saved reads survive browser changes but are not accessible to the other wallet. Confirm RPC/explorer/buy links and PNTH addresses, fresh Delphi data, empty-versus-active Trials state, new backup success and correct release BUILD_ID. Only then deliberately enable any mainnet keeper live mode / Passport relaying / X live posting, with an approved gas budget and nonce coordination for the shared role wallet. Leave X shadow if not approved.

**Three testnet timers:** snapshot is-enabled and is-active states before changing them. Disable/stop these timers AND stop any currently running corresponding services before mainnet cutover:
- pantheon-keep-basket.timer / service
- pantheon-restock.timer / service
- pantheon-round-3-start.timer / service

They contain testnet-specific addresses/drip/round logic. Do not repoint or restart them on mainnet. Use the new mainnet keeper; no production mainnet “restock faucet”; create a new mainnet Trials round explicitly. Restore only previously enabled/active timer states if rolling back to testnet.

First round cannot be fabricated on day one: constituent minimum age is 72 hours, weights cap at 20% (at least five eligible coins for a full basket), default voting requires a 3-day held stake at opensAt, and execution adds a 24-hour proposal delay. Show truthful “not yet open/no eligible basket” status; do not lower protocol rules to make it green.

When real eligible data exists, choose **TODO OPEN_AT** from the onchain launch/stake timestamps and reviewed voting schedule, then use the new release and actual mainnet environments:

```bash
# Run as the appropriate service User with its root-provisioned mainnet environment.
# These commands are read-only onchain and write ONLY isolated round/output files.
export NETWORK=mainnet DEPLOYMENT_FILE="$REPO/deployments/elysium-mainnet.json"
export DB_PATH="$STATE/delphi/delphi.db" OUT_DIR="$STATE/delphi/out"
export OPEN_AT=TODO_REVIEWED_UTC_TIMESTAMP_AFTER_ELIGIBILITY
test "$OPEN_AT" != TODO_REVIEWED_UTC_TIMESTAMP_AFTER_ELIGIBILITY
(cd "$REPO/services/delphi" && node scripts/trials.ts --round 1 --coins 10 --cap-usdc 100)
(cd "$REPO/services/trials" && node scripts/open.ts --round 1 --hours 46 \
  --opens "$OPEN_AT" --coins 10 --seats 3 --min-hold-days 3 \
  --delphi "$STATE/delphi/out" --out "$STATE/trials/rounds")
curl --fail http://127.0.0.1:19990/trials/current
```

Confirm round chainId=99901 and PNTH identity, snapshot/opens/closes times, candidates and stake eligibility. Keep testnet rounds/ballots untouched. Proposal submission after voting and permissionless execution after the registry delay require separate operator approval; do not use the old round-3 timer.

## 9. Rollback: UI/services, not the blockchain

Rollback cannot undo mainnet deployments, swaps, bridging or stakes. Never point a testnet build at mainnet services/state or copy databases across networks.

1. Keep mainnet keeper dry/stop its live operations and keep X shadow/stop live posting. Retain all mainnet state and receipts.
2. Start a warm **original testnet** web on 3001 from its saved original WorkingDirectory, environment and original active .next slot. Require testnet aggregate health and build identity.
3. Load a reviewed Caddy config routing web to warm 3001, and restore any direct public service dials to original testnet ports.
4. Remove ONLY our 90-mainnet.conf web drop-in, daemon-reload, restart original pantheon-web on 3000; old source/env/slot were never overwritten. Require testnet health.
5. Reload the saved caddy-before.json (web now healthy on 3000); verify public testnet health/build, then stop warm web.
6. Stop/disable new *-mainnet units/timer as appropriate; leave testnet backends/state intact. Restore the three old timers only to their recorded pre-launch enabled/active states. Preserve the new mainnet data for investigation.
7. Tell users the site is back on testnet; mainnet sign-ins will be rejected by chain-bound sessions and require fresh sign-in. Mainnet funds remain on mainnet.

## Copy-paste operational helpers

Run the timer snapshot/stop block **before the public switch in §7**, after recording any in-flight testnet job's status:

```bash
sudo env ENVROOT="$ENVROOT" python3 - <<'PY'
import os,json,subprocess
from pathlib import Path
names=["pantheon-keep-basket","pantheon-restock","pantheon-round-3-start"]
p=Path(os.environ["ENVROOT"])/"rollback"/"timers-before.json"
p.parent.mkdir(mode=0o700,exist_ok=True);assert not p.exists()
state={}
for n in names:
 state[n]={k:subprocess.run(["systemctl",k,n+".timer"],capture_output=True,text=True).stdout.strip() for k in ["is-enabled","is-active"]}
p.write_text(json.dumps(state));p.chmod(0o600)
for n in names:
 subprocess.run(["systemctl","disable","--now",n+".timer"],check=True)
 subprocess.run(["systemctl","stop",n+".service"],check=True)
PY
```

The legacy backup script expects a fixed directory layout. Make a mainnet-only backup view so it cannot collect tracked testnet rounds from the new code archive:

```bash
sudo env REPO="$REPO" STATE="$STATE" ENVROOT="$ENVROOT" NODE_BIN="$NODE_BIN" python3 - <<'PY'
import os,json
from pathlib import Path
r,s,e,node=map(os.environ.__getitem__,["REPO","STATE","ENVROOT","NODE_BIN"])
view=Path(s)/"backup-view"
for p in [view/"services"/"delphi",view/"deployments"]:p.mkdir(parents=True,exist_ok=True)
links={view/"services"/"passport":Path(r)/"services"/"passport",view/"services"/"delphi"/"package.json":Path(r)/"services"/"delphi"/"package.json",view/"services"/"delphi"/"node_modules":Path(r)/"services"/"delphi"/"node_modules",view/"services"/"delphi"/"out":Path(s)/"delphi"/"out",view/"deployments"/"trials":Path(s)/"trials"/"rounds",view/"deployments"/"elysium.json":Path(r)/"deployments"/"elysium-mainnet.json"}
for dest,source in links.items():
 if not dest.is_symlink():dest.symlink_to(source)
values={"REPO_ROOT":str(view),"SQLITE_HELPER":r+"/ops/backup/backup-sqlite.mjs","NODE":node,"BACKUP_DIR":"/var/backups/pantheon-mainnet","STATUS_FILE":s+"/ops/backup-status.json","INDEXER_STATE":s+"/indexer/index.json","PASSPORT_DB":s+"/passport/passport.db","TRIALS_STATE":s+"/trials/ballots.json","KEEPER_STATE":s+"/keeper/state.json","DELPHI_DB":s+"/delphi/delphi.db","DELPHI_FEED_DB":s+"/delphi/feed.db","DELPHI_X_DB":s+"/delphi/x.db"}
env=Path(e)/"backup.env";env.write_text("".join(k+"="+json.dumps(v)+"\n" for k,v in values.items()));env.chmod(0o600)
Path("/etc/systemd/system/pantheon-backup-mainnet.service").write_text("[Unit]\nDescription=Mainnet product-state backup and restore check\n[Service]\nType=oneshot\nUser=root\nEnvironmentFile="+str(env)+"\nExecStart=/bin/bash "+r+"/ops/backup/pantheon-backup.sh\n")
Path("/etc/systemd/system/pantheon-backup-mainnet.timer").write_text("[Unit]\nDescription=Mainnet daily backup\n[Timer]\nOnCalendar=daily\nPersistent=true\n[Install]\nWantedBy=timers.target\n")
PY
sudo systemctl daemon-reload
sudo systemctl start pantheon-backup-mainnet
sudo systemctl enable --now pantheon-backup-mainnet.timer
```

This uses the existing backup script's verified coverage. Uploaded guard/private wallet-read history is outside that script's scope: retain its isolated directory across releases and arrange a separately approved encrypted backup if restoration of that history is required. Do not claim the aggregate backup heartbeat covers that extra history.

After starting the original testnet warm listener and routing traffic to it as described in §9, restore the primary and original Caddy config:

```bash
sudo rm /etc/systemd/system/pantheon-web.service.d/90-mainnet.conf
sudo systemctl daemon-reload
sudo systemctl restart pantheon-web
curl --fail http://127.0.0.1:3000/api/health
sudo env ENVROOT="$ENVROOT" python3 - <<'PY'
import os,urllib.request
from pathlib import Path
data=(Path(os.environ["ENVROOT"])/"rollback"/"caddy-before.json").read_bytes()
urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:2019/load",data=data,headers={"Content-Type":"application/json"},method="POST")).read()
PY
sudo env ENVROOT="$ENVROOT" python3 - <<'PY'
import os,json,subprocess
from pathlib import Path
state=json.loads((Path(os.environ["ENVROOT"])/"rollback"/"timers-before.json").read_text())
for name,old in state.items():
 if old["is-enabled"]=="enabled":subprocess.run(["systemctl","enable",name+".timer"],check=True)
 elif old["is-enabled"]=="enabled-runtime":subprocess.run(["systemctl","enable","--runtime",name+".timer"],check=True)
 if old["is-active"]=="active":subprocess.run(["systemctl","start",name+".timer"],check=True)
PY
```

## Evidence / bounds

Local proof commands: start `anvil --host 127.0.0.1 --port 18545 --chain-id 99901 --silent`, then `node script/dev/prove-mainnet.mjs`. It uses public fixture key 1, not the user's key, installs mock dependency code with local Anvil methods, runs full Forge simulation, checks creator handoff/predicted vault, writes a temporary manifest and proves its network block is unchanged. It submits **zero** transactions; canonical mainnet nulls are restored/unchanged. Proof does not establish real Ascend mainnet ABI/venue availability or explorer verification.

Foundry warnings about missing 99901 explorer configuration are genuine remaining TODOs, not a successful verification. A previous unrelated Passport docs/passport-fixtures source-directory issue also remains; see phase-2-result.md. No production access or changes were made while preparing this runbook.

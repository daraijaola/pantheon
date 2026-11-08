"use client";

import { useSwitchChain } from "wagmi";
import { useHydratedConnection } from "@/lib/use-hydrated-connection";
import { elysium } from "@/lib/chain/config";
import { useConnectWallet } from "@/components/upload/use-connect-wallet";
import { reason } from "./shared";
import s from "./app.module.css";

export function ConnectWallet() {
  const { isConnected, chainId } = useHydratedConnection();
  const wallet = useConnectWallet();
  const change = useSwitchChain();
  if (isConnected && chainId === elysium.id) return null;
  return (
    <div className={`${s.wallet} ${s.localWallet}`}>
      {isConnected ? (
        <button type="button" className={s.primarySmall} disabled={change.isPending} onClick={() => change.mutate({ chainId: elysium.id })}>
          {change.isPending ? "Switching…" : "Switch to Elysium"}
        </button>
      ) : (
        <>
          <button type="button" className={s.primarySmall} disabled={wallet.busy} onClick={() => wallet.open("wallet")}>
            {wallet.busy ? "Connecting…" : "Connect wallet"}
          </button>
          {wallet.choices?.map((choice) => <button type="button" className={s.ghost} key={choice.id} onClick={() => wallet.pick(choice.id)}>{choice.name}</button>)}
          {wallet.choices && <button type="button" className={s.ghost} onClick={wallet.cancelPick}>Cancel</button>}
          {wallet.retry && <button type="button" className={s.ghost} onClick={wallet.retry}>Retry connection</button>}
          {wallet.cancel && <button type="button" className={s.ghost} onClick={wallet.cancel}>Cancel connection</button>}
          {wallet.message && <p role="status" className={s.hint}>{wallet.message}</p>}
        </>
      )}
      {(wallet.error || change.error) && <p role="alert" className={s.error}>{wallet.error ?? reason(change.error)}</p>}
    </div>
  );
}

"use client";

import { useSyncExternalStore } from "react";
import { useConnection, type UseConnectionReturnType } from "wagmi";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const disconnected: UseConnectionReturnType = {
  address: undefined,
  addresses: undefined,
  chain: undefined,
  chainId: undefined,
  connector: undefined,
  isConnected: false,
  isConnecting: false,
  isDisconnected: true,
  isReconnecting: false,
  status: "disconnected",
};

/** Streamed screens must hydrate with the server's wallet state, not a previously connected store. */
export function useHydratedConnection(): UseConnectionReturnType {
  const connection = useConnection();
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return hydrated ? connection : disconnected;
}

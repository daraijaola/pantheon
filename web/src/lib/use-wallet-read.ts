"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type WalletRead = { wallet: string; readAt: number; complete?: boolean; stages: Array<{ stage: string; ok: boolean; data?: unknown }> };
export type ReadState = { read: WalletRead | null; refreshAfter: number };

export async function walletRead(method = "GET"): Promise<ReadState> {
  const res = await fetch("/api/me/read", { method, cache: "no-store" });
  if (!res.ok) throw new Error("DELPHI couldn’t refresh your read. Try again shortly.");
  return res.json();
}

export function useWalletRead(wallet: string | null | undefined, refreshStale = false) {
  const client = useQueryClient();
  const key = ["me", "read", wallet];
  const query = useQuery({ queryKey: key, queryFn: () => walletRead(), enabled: !!wallet, staleTime: 60_000, retry: false });
  const refresh = useMutation({
    mutationFn: (owner: string) => {
      if (!owner) throw new Error("Sign in to refresh your read.");
      return walletRead("POST");
    },
    onSuccess: (state, owner) => {
      if (client.getQueryData(["me", "session"]) === owner && (!state.read || state.read.wallet === owner)) client.setQueryData(["me", "read", owner], state);
    },
    onError: () => { void client.invalidateQueries({ queryKey: key }); },
  });
  const { mutate } = refresh;
  useEffect(() => {
    if (!refreshStale || !wallet || !query.data) return;
    const next = Math.max(query.data.read && query.data.read.complete !== false ? query.data.read.readAt + 86_400_000 : 0, query.data.refreshAfter);
    const timer = setTimeout(() => mutate(wallet), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [refreshStale, wallet, query.data, mutate]);
  return { ...query, refresh: () => mutate(wallet ?? ""), refreshing: refresh.isPending, refreshError: refresh.error?.message ?? query.error?.message };
}

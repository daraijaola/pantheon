"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type WalletRead = { wallet: string; readAt: number; stages: Array<{ stage: string; ok: boolean; data?: unknown }> };
export type ReadState = { read: WalletRead | null; refreshAfter: number };

export async function walletRead(method = "GET"): Promise<ReadState> {
  const res = await fetch("/api/me/read", { method, cache: "no-store" });
  if (!res.ok) throw new Error("DELPHI couldn’t refresh your read. Try again shortly.");
  return res.json();
}

export function useWalletRead(wallet: string | null | undefined, refreshStale = false) {
  const client = useQueryClient();
  const key = ["me", "read", wallet];
  const attempted = useRef<string | null>(null);
  const query = useQuery({ queryKey: key, queryFn: () => walletRead(), enabled: !!wallet, staleTime: 60_000, retry: false });
  const refresh = useMutation({
    mutationFn: () => walletRead("POST"),
    onSuccess: (state) => client.setQueryData(key, state),
    onError: () => { void client.invalidateQueries({ queryKey: key }); },
  });
  const { mutate } = refresh;
  useEffect(() => {
    if (!refreshStale || !wallet || !query.data || attempted.current === wallet) return;
    attempted.current = wallet;
    if ((!query.data.read || Date.now() - query.data.read.readAt > 86_400_000) && Date.now() >= query.data.refreshAfter) mutate();
  }, [refreshStale, wallet, query.data, mutate]);
  return { ...query, refresh: () => mutate(), refreshing: refresh.isPending, refreshError: refresh.error?.message };
}

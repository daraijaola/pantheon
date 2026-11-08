"use client";

import { useQuery } from "@tanstack/react-query";

export type WalletRead = { wallet: string; readAt: number; stages: Array<{ stage: string; ok: boolean; data?: unknown }> };
export type ReadState = { read: WalletRead | null; refreshAfter: number };

export async function walletRead(method = "GET"): Promise<ReadState> {
  const res = await fetch("/api/me/read", { method, cache: "no-store" });
  if (!res.ok) throw new Error("DELPHI couldn’t refresh your read. Try again shortly.");
  return res.json();
}

export function useWalletRead(wallet: string | null | undefined) {
  return useQuery({ queryKey: ["me", "read", wallet], queryFn: () => walletRead(), enabled: !!wallet, staleTime: 60_000, retry: false });
}

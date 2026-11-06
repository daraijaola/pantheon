"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { clearSession } from "@/lib/auth-client";

export function useSession() {
  return useQuery({
    queryKey: ["me", "session"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const body = res.ok ? await res.json() as { wallet: string | null } : null;
      return body?.wallet ?? null;
    },
    retry: false, staleTime: 60_000,
  });
}
export function AuthSession() {
  const { address, status } = useConnection();
  const client = useQueryClient();
  const previous = useRef<string | null>(null);
  const session = useSession();
  useEffect(() => {
    if (status === "reconnecting" || status === "connecting") return;
    const wallet = status === "connected" ? address?.toLowerCase() ?? null : null;
    const changed = previous.current !== null && previous.current !== wallet;
    previous.current = wallet;
    if (!changed && !(wallet && session.data && wallet !== session.data.toLowerCase())) return;
    void clearSession(client).catch(() => client.invalidateQueries({ queryKey: ["me", "session"] }));
  }, [address, status, session.data, client]);
  return null;
}

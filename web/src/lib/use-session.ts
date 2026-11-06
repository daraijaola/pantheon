"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

const subscribe = () => () => {};
const mountedSnapshot = () => true;
const serverSnapshot = () => false;

export function useSession() {
  const mounted = useSyncExternalStore(subscribe, mountedSnapshot, serverSnapshot);
  const session = useQuery({
    queryKey: ["me", "session"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const body = res.ok ? await res.json() as { wallet: string | null } : null;
      return body?.wallet ?? null;
    },
    enabled: mounted,
    retry: false, staleTime: 60_000,
  });
  return { data: mounted ? session.data : undefined, isPending: !mounted || session.isPending };
}

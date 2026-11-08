"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHydratedConnection } from "@/lib/use-hydrated-connection";
import { clearSession } from "@/lib/auth-client";
import { useSession } from "@/lib/use-session";

export { useSession };
export function AuthSession() {
  const { address, status } = useHydratedConnection();
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

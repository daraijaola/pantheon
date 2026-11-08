import { createSiweMessage } from "viem/siwe";
import type { Address } from "viem";
import type { QueryClient } from "@tanstack/react-query";

let loggingOut: Promise<void> = Promise.resolve();
export function logoutSession() {
  loggingOut = loggingOut.catch(() => {}).then(async () => {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    if (!res.ok) throw new Error("Sign out could not be completed. Try again.");
  });
  return loggingOut;
}
export function clearSession(client: QueryClient) {
  const logout = logoutSession();
  void client.cancelQueries({ queryKey: ["me"] });
  client.setQueryData(["me", "session"], null);
  client.removeQueries({ predicate: (query) => query.queryKey[0] === "me" && query.queryKey[1] !== "session" });
  client.removeQueries({ queryKey: ["auth", "nonce"] });
  return logout;
}
export async function prepareSignIn(address: Address) {
  await loggingOut;
  const res = await fetch("/api/auth/nonce", { cache: "no-store" });
  if (!res.ok) throw new Error("Sign in is unavailable. Try again.");
  const challenge = await res.json() as { nonce: string; domain: string; uri: string; chainId: number; issuedAt: string; expirationTime: string };
  return createSiweMessage({ ...challenge, address, version: "1", issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expirationTime), statement: "Sign to let DELPHI read this wallet and build your space. Free: nothing is sent and no fee is paid." });
}
export async function verifySignIn(message: string, signature: string) {
  const res = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
  if (!res.ok) throw new Error("Sign in could not be verified. Sign again to go on.");
  return await res.json() as { wallet: string };
}

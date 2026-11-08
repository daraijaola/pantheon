export async function uploadDestination(fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const session = await fetcher("/api/auth/me", { cache: "no-store" });
    if (session.ok && (await session.json()).wallet) {
      const read = await fetcher("/api/me/read", { cache: "no-store" });
      if (read.ok && (await read.json()).read) return "/space";
    }
  } catch { /* Onboarding can retry unavailable reads. */ }
  return "/upload";
}

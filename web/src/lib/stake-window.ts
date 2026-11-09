export type StakeWindow = { start: number; end: number };
export const STAKE_WINDOW_SECONDS = 20 * 60;

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 253402300799 ? seconds : null;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!iso) return null;
  const days = new Date(Date.UTC(Number(iso[1]), Number(iso[2]), 0)).getUTCDate();
  if (Number(iso[2]) < 1 || Number(iso[2]) > 12 || Number(iso[3]) < 1 || Number(iso[3]) > days) return null;
  const seconds = Date.parse(text) / 1000;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function readStakeWindow(env: Record<string, string | undefined>): StakeWindow | null {
  const start = timestamp(env.STAKING_WINDOW_START);
  const end = timestamp(env.STAKING_WINDOW_END);
  return start !== null && end !== null && end - start === STAKE_WINDOW_SECONDS ? { start, end } : null;
}

export function stakeWindowState(window: StakeWindow | null, now: number): "unconfigured" | "before" | "open" | "closed" {
  if (!window || window.end - window.start !== STAKE_WINDOW_SECONDS || !Number.isFinite(now)) return "unconfigured";
  return now < window.start ? "before" : now < window.end ? "open" : "closed";
}

export function assertStakeWindowOpen(window: StakeWindow | null, now: number) {
  if (stakeWindowState(window, now) !== "open") throw new Error("Staking window is not open. No further staking transaction was sent.");
}

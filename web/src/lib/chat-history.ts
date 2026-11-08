export const CHAT_HISTORY_KEY = "pantheon.delphi.chats.v1";
export type SavedCoin = { symbol: string | null; token: string; verdict: "FLAG" | "WATCH" | "CLEAN" | "NOT_ENOUGH_DATA"; market: "ascend" | "kalos" | "perpme" };
export type SavedTurn = { id: number; question: string; text: string; coins: SavedCoin[]; proofs: string[]; sig?: string; status: "done" | "error"; error?: string };
export type SavedChat = { id: string; title: string; updatedAt: number; turns: SavedTurn[] };
export type ChatHistory = { active: string | null; chats: SavedChat[] };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function turn(value: unknown): value is SavedTurn {
  if (!object(value)) return false;
  return Number.isInteger(value.id) && typeof value.question === "string" && typeof value.text === "string"
    && ["done", "error"].includes(String(value.status)) && strings(value.proofs)
    && (value.sig === undefined || typeof value.sig === "string") && (value.error === undefined || typeof value.error === "string")
    && Array.isArray(value.coins) && value.coins.every((coin: unknown) => object(coin)
      && (coin.symbol === null || typeof coin.symbol === "string") && typeof coin.token === "string"
      && ["FLAG", "WATCH", "CLEAN", "NOT_ENOUGH_DATA"].includes(String(coin.verdict)) && ["ascend", "kalos", "perpme"].includes(String(coin.market)));
}

export function loadChats(raw: string | null): ChatHistory {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!object(value) || !Array.isArray(value.chats)) return { active: null, chats: [] };
    const chats = value.chats.filter((chat: unknown): chat is SavedChat => object(chat) && typeof chat.id === "string"
      && typeof chat.title === "string" && Number.isFinite(chat.updatedAt) && Array.isArray(chat.turns) && chat.turns.length > 0 && chat.turns.every(turn));
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    return { active: typeof value.active === "string" && chats.some((chat) => chat.id === value.active) ? value.active : null, chats };
  } catch { return { active: null, chats: [] }; }
}

export function saveChat(history: ChatHistory, id: string, turns: SavedTurn[], now = Date.now()): ChatHistory {
  if (!turns.length) return history;
  const chat: SavedChat = { id, title: turns[0].question.trim().slice(0, 100), updatedAt: now, turns };
  return { active: id, chats: [chat, ...history.chats.filter((item) => item.id !== id)] };
}

export function deleteChat(history: ChatHistory, id: string): ChatHistory {
  return { active: history.active === id ? null : history.active, chats: history.chats.filter((chat) => chat.id !== id) };
}

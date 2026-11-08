import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedTurn } from "./chat-history";
const { loadChats, saveChat, deleteChat } = await import(new URL("./chat-history.ts", import.meta.url).href) as typeof import("./chat-history");

const turns: SavedTurn[] = [{ id: 1, question: "Is PACT clean?", text: "Read the report.", status: "done", proofs: ["proof"], coins: [], sig: "signed-answer" }];

test("chat history preserves completed answers, proofs and signatures across reload", () => {
  const saved = saveChat({ active: null, chats: [] }, "one", turns, 100);
  assert.deepEqual(loadChats(JSON.stringify(saved)), saved);
  assert.equal(saved.chats[0].title, "Is PACT clean?");
});
test("recent chats order by latest use, full history retains more than ten and deletion clears active", () => {
  let history = loadChats(null);
  for (let i = 0; i < 12; i++) history = saveChat(history, String(i), turns, i);
  assert.equal(history.chats.length, 12);
  assert.deepEqual(history.chats.slice(0, 10).map((chat) => chat.id), ['11', '10', '9', '8', '7', '6', '5', '4', '3', '2']);
  history = saveChat(history, "0", turns, 15);
  assert.equal(history.chats[0].id, "0");
  assert.equal(history.chats.length, 12);
  history = deleteChat(history, "0");
  assert.equal(history.active, null);
  assert.equal(history.chats.length, 11);
});
for (const raw of [null, '', 'broken', '{}', '{"chats":[{"id":"bad","turns":[{}]}]}']) {
  test(`empty or invalid chat storage is safe: ${raw}`, () => assert.deepEqual(loadChats(raw), { active: null, chats: [] }));
}
test("an empty chat does not replace saved history", () => {
  const history = saveChat(loadChats(null), "one", turns);
  assert.equal(saveChat(history, "two", []), history);
});

test("history round trips signed answer whitespace without normalization", () => {
  const text = "\n  A signed answer.  \n\n";
  const saved = saveChat(loadChats(null), "signed", [{ ...turns[0], text }]);
  const restored = loadChats(JSON.stringify(saved)).chats[0].turns[0];
  assert.equal(restored.text, text);
  assert.equal(restored.sig, turns[0].sig);
});

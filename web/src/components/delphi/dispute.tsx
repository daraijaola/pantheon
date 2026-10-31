"use client";
// The page every DELPHI flag links to: anyone who thinks a check is wrong says why, and a person
// answers within 24 hours with the evidence. It posts to the feed's dispute endpoint; nothing else.

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import s from "@/components/app/app.module.css";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
type Sent = { state: "idle" } | { state: "sending" } | { state: "sent" } | { state: "error"; message: string };

export function DisputeForm({ token: initial }: { token: string }) {
  const [token, setToken] = useState(initial);
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const ready = ADDRESS.test(token.trim()) && contact.trim().length >= 2 && message.trim().length >= 10;

  async function send() {
    setSent({ state: "sending" });
    try {
      const res = await fetch("/api/delphi/v1/dispute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim().toLowerCase(), contact: contact.trim(), message: message.trim() }),
      });
      if (res.ok) return setSent({ state: "sent" });
      setSent({ state: "error", message: res.status === 429 ? "Too many disputes from here for now. Try again in an hour." : "That didn't go through. Check the address and try again." });
    } catch {
      setSent({ state: "error", message: "We couldn't reach DELPHI. Try again in a minute." });
    }
  }

  if (sent.state === "sent") {
    return (
      <section className={s.cell}>
        <p className={s.label}>Received</p>
        <p className={s.sub}>A person reads every dispute and answers within 24 hours, with the transactions behind the answer. If DELPHI was wrong, the check changes and its history says why.</p>
      </section>
    );
  }
  return (
    <section className={s.cell}>
      <label className={s.field}>
        <span className={s.fieldTop}>Coin address</span>
        <span className={s.inputRow}>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" spellCheck={false} style={{ font: "14px var(--mono)" }} />
        </span>
      </label>
      <label className={s.field} style={{ marginTop: 10 }}>
        <span className={s.fieldTop}>How we reach you (X handle, Telegram or email)</span>
        <span className={s.inputRow}>
          <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} placeholder="@you" style={{ fontSize: 15, fontFamily: "inherit" }} />
        </span>
      </label>
      <label className={s.field} style={{ marginTop: 10 }}>
        <span className={s.fieldTop}>What DELPHI got wrong, and how you know</span>
        <span className={s.inputRow}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={1200}
            rows={6}
            placeholder="For example: those two wallets are our market maker, here is the transaction that shows it."
            style={{ width: "100%", border: 0, outline: 0, background: "transparent", fontSize: 15, lineHeight: "22px", fontFamily: "inherit", resize: "vertical" }}
          />
        </span>
      </label>
      <button className={s.primary} disabled={!ready || sent.state === "sending"} onClick={send}>
        {sent.state === "sending" ? "Sending…" : "Send dispute"}
      </button>
      {sent.state === "error" && <p className={s.error}>{sent.message}</p>}
      <p className={s.hint}>Free, and answered by a person within 24 hours. Evidence helps: transactions or addresses that show who a wallet really is.</p>
    </section>
  );
}

/** The form, with the coin taken from the link (?token=0x…) every DELPHI flag carries. */
export function DisputeFromLink() {
  const token = useSearchParams().get("token") ?? "";
  return <DisputeForm token={ADDRESS.test(token) ? token : ""} />;
}

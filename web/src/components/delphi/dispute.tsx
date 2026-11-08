"use client";
// The page every DELPHI flag links to: anyone who thinks a check is wrong says why, and a person
// answers within 24 hours with the evidence. It posts to the feed's dispute endpoint; nothing else.

import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import s from "@/components/app/app.module.css";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
type Sent = { state: "idle" } | { state: "sending" } | { state: "sent" } | { state: "error"; message: string };

export function DisputeForm({ token: initial }: { token: string }) {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const [token, setToken] = useState(initial);
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const tokenError = ADDRESS.test(token.trim()) ? null : token.trim() ? "Enter a valid coin address: 0x followed by 40 hex characters." : "Enter the coin address.";
  const contactError = contact.trim().length >= 2 ? null : "Add a contact with at least 2 characters so we can reply.";
  const messageError = message.trim().length >= 10 ? null : "Add at least 10 characters explaining what DELPHI got wrong.";
  const ready = !tokenError && !contactError && !messageError;

  async function send() {
    if (!hydrated || !ready || sent.state === "sending") return;
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
          <input disabled={!hydrated} value={token} aria-invalid={!!tokenError} aria-describedby={tokenError ? "dispute-token-error" : undefined} onChange={(e) => setToken(e.target.value)} placeholder="0x…" spellCheck={false} style={{ font: "14px var(--mono)" }} />
        </span>
      </label>
      {tokenError && <p id="dispute-token-error" className={s.hint}>{tokenError}</p>}
      <label className={s.field} style={{ marginTop: 10 }}>
        <span className={s.fieldTop}>How we reach you (X handle, Telegram or email)</span>
        <span className={s.inputRow}>
          <input disabled={!hydrated} value={contact} aria-invalid={!!contactError} aria-describedby={contactError ? "dispute-contact-error" : undefined} onChange={(e) => setContact(e.target.value)} maxLength={120} placeholder="@you" style={{ fontSize: 15, fontFamily: "inherit" }} />
        </span>
      </label>
      {contactError && <p id="dispute-contact-error" className={s.hint}>{contactError}</p>}
      <label className={s.field} style={{ marginTop: 10 }}>
        <span className={s.fieldTop}>What DELPHI got wrong, and how you know</span>
        <span className={s.inputRow}>
          <textarea
            disabled={!hydrated}
            value={message}
            aria-invalid={!!messageError}
            aria-describedby={messageError ? "dispute-message-error" : undefined}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={1200}
            rows={6}
            placeholder="For example: those two wallets are our market maker, here is the transaction that shows it."
            style={{ width: "100%", border: 0, outline: 0, background: "transparent", fontSize: 15, lineHeight: "22px", fontFamily: "inherit", resize: "vertical" }}
          />
        </span>
      </label>
      {messageError && <p id="dispute-message-error" className={s.hint}>{messageError}</p>}
      <button className={s.primary} disabled={!hydrated || !ready || sent.state === "sending"} onClick={send}>
        {sent.state === "sending" ? "Sending…" : "Send dispute"}
      </button>
      {sent.state === "error" && <p className={s.error} role="alert">{sent.message}</p>}
      <p className={s.hint}>Free, and answered by a person within 24 hours. Evidence helps: transactions or addresses that show who a wallet really is.</p>
    </section>
  );
}

/** The form, with the coin taken from the link (?token=0x…) every DELPHI flag carries. */
export function DisputeFromLink() {
  const token = useSearchParams().get("token") ?? "";
  return <DisputeForm token={token} />;
}

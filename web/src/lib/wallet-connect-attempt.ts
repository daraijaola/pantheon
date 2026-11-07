export type WalletPhase = "initializing" | "pairing" | "ready" | "slow" | "init-failed" | "failed" | "relay-failed" | "connected" | "cancelled";
type Listener = (...args: unknown[]) => void;
type Events = { on(event: string, listener: Listener): void; removeListener(event: string, listener: Listener): void };
export type PairingProvider = Events & {
  session?: unknown;
  modal?: { close(): void };
  signer: {
    cleanupPendingPairings(options: { deletePairings: boolean }): Promise<void>;
    client: {
      proposal: { getAll(): { id: number }[] };
      core: { expirer: { set(id: number, expiry: number): void }; relayer: Events };
    };
  };
};

export function walletAttempt(options: {
  init(): Promise<PairingProvider>;
  pair(): Promise<unknown>;
  disconnect(): Promise<void>;
  update(phase: WalletPhase): void;
  waitMs?: number;
}) {
  let active = true;
  let provider: PairingProvider | undefined;
  let pairing: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  let ready = false;
  const detach = () => {
    clearTimeout(timer);
    provider?.removeListener("display_uri", onUri);
    provider?.removeListener("error", onError);
    provider?.signer.client.core.relayer.removeListener("relayer_error", onRelayError);
  };
  const clean = async () => {
    if (!provider) return;
    provider.modal?.close();
    // abortPairingAttempt() is a no-op in this SDK. Expire proposals and pairings instead.
    for (const proposal of provider.signer.client.proposal.getAll()) provider.signer.client.core.expirer.set(proposal.id, 0);
    await provider.signer.cleanupPendingPairings({ deletePairings: true });
    await pairing?.catch(() => {});
    if (provider.session) await options.disconnect();
  };
  const stop = (phase: WalletPhase) => {
    if (!active) return stopping ?? Promise.resolve();
    active = false;
    detach();
    if (!provider) {
      // Never wait on a stalled init: report now, clean up a provider that arrives later.
      options.update(phase);
      void initialized.then(clean).catch(() => {});
      stopping = Promise.resolve();
      return stopping;
    }
    stopping = clean().then(() => options.update(phase), () => options.update("failed"));
    return stopping;
  };
  function onUri() {
    if (!active) return;
    ready = true;
    clearTimeout(timer);
    provider?.removeListener("display_uri", onUri);
    options.update("ready");
  }
  function onError() { void stop("failed"); }
  function onRelayError() { void stop("relay-failed"); }
  options.update("initializing");
  const initialized = options.init().then(p => { provider = p; });
  const done = initialized.then(async () => {
    if (!active) return;
    provider!.on("display_uri", onUri);
    provider!.on("error", onError);
    provider!.signer.client.core.relayer.on("relayer_error", onRelayError);
    options.update("pairing");
    timer = setTimeout(() => { if (!ready) void stop("slow"); }, options.waitMs ?? 12_000);
    pairing = options.pair();
    await pairing;
    if (!active) return;
    active = false;
    detach();
    options.update("connected");
  }).catch(async error => {
    if (!active) return;
    const cancelled = /user rejected|connection request reset|user cancel/i.test(error instanceof Error ? error.message : String(error));
    await stop(!provider ? "init-failed" : cancelled ? "cancelled" : "failed");
  });
  return { done, cancel: () => stop("cancelled") };
}

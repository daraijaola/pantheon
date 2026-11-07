import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createConfig, http, WagmiProvider } from "wagmi";
import { getConnection } from "wagmi/actions";
import { mock } from "wagmi/connectors";

const { useHydratedConnection } = await import(new URL("./use-hydrated-connection.ts", import.meta.url).href);
const address = "0x0000000000000000000000000000000000000042";
const chain = { id: 99801, name: "Fixture", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:4174/rpc"] } } } as const;

function Identity() {
  const { address, chainId, status, isConnected } = useHydratedConnection();
  return createElement("output", null, `${status}|${isConnected}|${address ?? "none"}|${chainId ?? "none"}`);
}

for (const chainId of [undefined, 99801, 1]) {
  test(`SSR wallet snapshot stays disconnected with ${chainId ?? "no"} chain in the store`, () => {
    const config = createConfig({ chains: [chain], connectors: [mock({ accounts: [address] })], transports: { [chain.id]: http() }, ssr: true });
    if (chainId !== undefined) {
      const connector = config.connectors[0];
      config.setState(state => ({ ...state, current: connector.uid, status: "connected", connections: new Map([[connector.uid, { accounts: [address], chainId, connector }]]) }));
      assert.equal(getConnection(config).isConnected, true);
    } else assert.equal(getConnection(config).isDisconnected, true);
    assert.equal(renderToString(createElement(WagmiProvider, { config, reconnectOnMount: false }, createElement(Identity))), "<output>disconnected|false|none|none</output>");
  });
}

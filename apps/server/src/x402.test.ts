import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ATTRIBUTION_CODE } from "@tanda/wallet";
import { USDT_ADDRESS } from "@tanda/money";
import { createApp, DEFAULT_PAY_TO } from "./index.js";
import { MockSelfVerifier, mockSignRequest } from "./self.js";
import {
  buildDeskRoutes,
  hasX402ApiKey,
  settlementReadiness,
} from "./x402.js";

describe("desk route config", () => {
  it("prices the order in explicit USDT, never a bare dollar string", () => {
    const routes = buildDeskRoutes({
      payTo: DEFAULT_PAY_TO,
      price: "0.10",
      network: "mainnet",
    });
    const route = routes["POST /desk/order"];
    const accept = route.accepts[0] as unknown as {
      scheme: string;
      network: string;
      payTo: string;
      price: { amount: string; asset: string; extra: { name: string; version: string } };
    };
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("eip155:42220");
    expect(accept.payTo).toBe(DEFAULT_PAY_TO);
    expect(accept.price.amount).toBe("100000");
    expect(accept.price.asset).toBe(USDT_ADDRESS);
    expect(accept.price.extra).toEqual({ name: "Tether USD", version: "1" });
  });

  it("declares the builder-code extension with the issued attribution code", () => {
    const routes = buildDeskRoutes({
      payTo: DEFAULT_PAY_TO,
      price: "0.10",
      network: "mainnet",
    });
    const extensions = routes["POST /desk/order"].extensions as Record<
      string,
      { info?: { a?: string } }
    >;
    expect(extensions["builder-code"]).toBeDefined();
    expect(JSON.stringify(extensions["builder-code"])).toContain(ATTRIBUTION_CODE);
  });

  it("testnet routes price in Sepolia USDC with its own EIP-712 domain", () => {
    const routes = buildDeskRoutes({
      payTo: DEFAULT_PAY_TO,
      price: "0.10",
      network: "testnet",
    });
    const accept = routes["POST /desk/order"].accepts[0] as unknown as {
      network: string;
      price: { asset: string; extra: { name: string; version: string } };
    };
    expect(accept.network).toBe("eip155:11142220");
    expect(accept.price.asset).toBe("0x01C5C0122039549AD1493B8220cABEdD739BC44E");
    expect(accept.price.extra).toEqual({ name: "USDC", version: "2" });
  });
});

describe("API key boundary", () => {
  it("hasX402ApiKey only accepts the x402_ key shape", () => {
    expect(hasX402ApiKey({})).toBe(false);
    expect(hasX402ApiKey({ X402_API_KEY: "nope" })).toBe(false);
    expect(hasX402ApiKey({ X402_API_KEY: "x402_test_placeholder" })).toBe(true);
  });

  it("settlement readiness names the human step when the key is missing", () => {
    const readiness = settlementReadiness({});
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain("x402.celo.org");
    expect(readiness.reason).toContain("Sign in with GitHub");
  });
});

describe("the desk answers a proper 402", () => {
  it("POST /desk/order without payment returns 402 with the priced requirement and builder code", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const verifier = new MockSelfVerifier({
      [account.address]: {
        agentId: 5n,
        nullifier: 99n,
        hasHumanProof: true,
        isProofFresh: true,
      },
    });
    // syncFacilitatorOnStart stays at its default (true): initialize()
    // reads the testnet facilitator public /supported list only. No API
    // key, no funds, and no settlement are involved in this test.
    const app = createApp({
      verifier,
      network: "testnet",
    });
    const url = "http://localhost/desk/order";
    const body = JSON.stringify({ serviceId: "translation-check" });
    const headers = await mockSignRequest(account, {
      method: "POST",
      url,
      body,
    });
    const res = await app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(header as string, "base64").toString("utf8"),
    ) as {
      accepts: Array<{ payTo: string; network: string; asset?: string; amount?: string }>;
      extensions?: Record<string, unknown>;
    };
    expect(decoded.accepts[0].payTo).toBe(DEFAULT_PAY_TO);
    expect(decoded.accepts[0].network).toBe("eip155:11142220");
    expect(JSON.stringify(decoded.extensions ?? {})).toContain(ATTRIBUTION_CODE);
  });
});

import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  normalizeQuote,
  type RawTextileQuote,
} from "@tanda/textile";
import { createApp } from "./index.js";
import { MockSelfVerifier, mockSignRequest } from "./self.js";

const FIXTURE: RawTextileQuote = {
  id: "rfq_fixture_1",
  status: "quoted",
  sellAmount: "1500000",
  buyAmount: "2400000",
  feeBps: 10,
};

function appWithMocks() {
  const account = privateKeyToAccount(generatePrivateKey());
  const verifier = new MockSelfVerifier({
    [account.address]: {
      agentId: 5n,
      nullifier: 99n,
      hasHumanProof: true,
      isProofFresh: true,
    },
  });
  const app = createApp({
    verifier,
    x402Enabled: false,
    textileClient: {
      previewQuote: async (input: { usdtAmount: string }) =>
        normalizeQuote(FIXTURE, input),
    },
  });
  return { app, account };
}

describe("desk app", () => {
  it("health reports the chain, the tag, and readiness flags", async () => {
    const { app } = appWithMocks();
    const res = await app.request("http://localhost/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      chainId: number;
      attributionCode: string;
    };
    expect(json.chainId).toBe(42220);
    expect(json.attributionCode).toBe("celo_f58da6359b7f");
  });

  it("quote route returns a normalized quote with the floor check", async () => {
    const { app } = appWithMocks();
    const res = await app.request("http://localhost/desk/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usdtAmount: "1.50", floorRate: "15000" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      quote: { idrxAmount: string; effectiveRateIdrxPerUsdt: string };
      meetsFloorRate: boolean;
    };
    expect(json.quote.idrxAmount).toBe("24000");
    expect(json.quote.effectiveRateIdrxPerUsdt).toBe("16000");
    expect(json.meetsFloorRate).toBe(true);
  });

  it("quote route rejects a missing amount", async () => {
    const { app } = appWithMocks();
    const res = await app.request("http://localhost/desk/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("order route: unverified agent is refused before any payment step", async () => {
    const { app } = appWithMocks();
    const res = await app.request("http://localhost/desk/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("order route: verified agent passes the Self gate (x402 disabled in this test app)", async () => {
    const { app, account } = appWithMocks();
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
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      status: string;
      agent: { nullifier: string; tier: string };
    };
    expect(json.status).toBe("order_created");
    expect(json.agent.nullifier).toBe("99");
    expect(json.agent.tier).toBe("full");
  });
});

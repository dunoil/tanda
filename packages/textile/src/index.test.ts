import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IDRX_ADDRESS, USDT_ADDRESS } from "@tanda/money";
import {
  TEXTILE_API_BASE,
  TextileNoQuoteError,
  TextileQuoteClient,
  buildQuoteWireBody,
  meetsFloorRate,
  normalizeQuote,
  signTakerControl,
  verifyTakerControl,
  type FetchFn,
  type RawTextileQuote,
} from "./index.js";

/**
 * Fixture in the documented RFQ v2 response shape (addresses as token
 * fields, raw unit amounts as strings). Rate used: 16,000 IDRX per USDT,
 * so 1.50 USDT buys 24,000 IDRX, which is 2,400,000 raw IDRX units at
 * 2 decimals. Recorded shape, illustrative values: tests never call the
 * live API.
 */
const FIXTURE_QUOTE: RawTextileQuote = {
  id: "rfq_fixture_1",
  status: "quoted",
  sellAmount: "1500000",
  buyAmount: "2400000",
  feeBps: 10,
  expiresAt: "2026-11-22T02:00:00Z",
  claimToken: "claim_fixture",
};

function mockFetchReturning(body: unknown, status = 200): FetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as FetchFn;
}

describe("wire body", () => {
  it("uses token addresses, chain 42220, and raw USDT units from the money module", () => {
    const body = buildQuoteWireBody({ usdtAmount: "1.50" });
    expect(body).toEqual({
      chainId: 42220,
      sellToken: USDT_ADDRESS,
      buyToken: IDRX_ADDRESS,
      sellAmount: "1500000",
    });
  });
});

describe("preview quote", () => {
  it("posts to /rfq/preview and normalizes through the money module", async () => {
    const fetchFn = mockFetchReturning(FIXTURE_QUOTE);
    const client = new TextileQuoteClient({ fetchFn });
    const quote = await client.previewQuote({ usdtAmount: "1.50" });
    expect(fetchFn).toHaveBeenCalledWith(
      `${TEXTILE_API_BASE}/rfq/preview`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(quote.id).toBe("rfq_fixture_1");
    expect(quote.usdtAmount).toBe("1.5");
    expect(quote.idrxRaw).toBe(2_400_000n);
    expect(quote.idrxAmount).toBe("24000");
    expect(quote.effectiveRateIdrxPerUsdt).toBe("16000");
    expect(quote.claimToken).toBe("claim_fixture");
  });

  it("floor rate check passes at or above the floor and fails below it", async () => {
    const client = new TextileQuoteClient({
      fetchFn: mockFetchReturning(FIXTURE_QUOTE),
    });
    const quote = await client.previewQuote({ usdtAmount: "1.50" });
    expect(meetsFloorRate(quote, "15999.5")).toBe(true);
    expect(meetsFloorRate(quote, "16000")).toBe(true);
    expect(meetsFloorRate(quote, "16000.01")).toBe(false);
  });

  it("throws a typed no quote error on a no_quote response", async () => {
    const client = new TextileQuoteClient({
      fetchFn: mockFetchReturning({ status: "no_quote" }),
    });
    await expect(client.previewQuote({ usdtAmount: "0.10" })).rejects.toBeInstanceOf(
      TextileNoQuoteError,
    );
  });

  it("normalizeQuote rejects a response with no buyAmount", () => {
    expect(() =>
      normalizeQuote({ status: "quoted" }, { usdtAmount: "1" }),
    ).toThrow(TextileNoQuoteError);
  });
});

describe("firm quote proof of control flow", () => {
  it("signs TakerControl only after a 401 proof request, then retries", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    let calls = 0;
    type MockResponse = {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
      text: () => Promise<string>;
    };
    const fetchFn = vi.fn(
      async (_url: string, init?: RequestInit): Promise<MockResponse> => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 401,
          json: async () => ({
            error: { details: { reason: "proof_of_control_required" } },
          }),
          text: async () => "proof required",
        };
      }
      const sent = JSON.parse(String(init?.body)) as {
        taker: string;
        takerProof?: { nonce: `0x${string}`; issuedAt: number; signature: `0x${string}` };
      };
      expect(sent.taker).toBe(account.address);
      expect(sent.takerProof).toBeDefined();
      const verified = await verifyTakerControl({
        taker: account.address,
        chainId: 42220,
        nonce: sent.takerProof!.nonce,
        issuedAt: sent.takerProof!.issuedAt,
        signature: sent.takerProof!.signature,
      });
      expect(verified).toBe(true);
      return {
        ok: true,
        status: 200,
        json: async () => FIXTURE_QUOTE,
        text: async () => JSON.stringify(FIXTURE_QUOTE),
      };
    }) as unknown as FetchFn;
    const client = new TextileQuoteClient({ fetchFn });
    const quote = await client.requestFirmQuote({ usdtAmount: "1.50", account });
    expect(calls).toBe(2);
    expect(quote.idrxAmount).toBe("24000");
  });

  it("TakerControl signatures verify against the taker and fail for another wallet", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const proof = await signTakerControl(account, 42220);
    await expect(
      verifyTakerControl({ taker: account.address, chainId: 42220, ...proof }),
    ).resolves.toBe(true);
    await expect(
      verifyTakerControl({ taker: other.address, chainId: 42220, ...proof }),
    ).resolves.toBe(false);
  });
});

describe("execution boundary", () => {
  it("submitQuote always refuses in this prep build", async () => {
    const client = new TextileQuoteClient({
      fetchFn: mockFetchReturning(FIXTURE_QUOTE),
    });
    await expect(client.submitQuote()).rejects.toThrow(/disabled in this prep build/);
  });
});

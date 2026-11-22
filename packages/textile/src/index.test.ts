import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IDRX_ADDRESS, USDT_ADDRESS } from "@tanda/money";
import { getAttributionSuffix } from "@tanda/wallet";
import {
  TEXTILE_API_BASE,
  TEXTILE_EXECUTION_ENV,
  TEXTILE_LIMIT_ORDER_REACTOR,
  TextileNoQuoteError,
  TextileQuoteClient,
  buildQuoteWireBody,
  isTextileExecutionEnabled,
  meetsFloorRate,
  normalizeQuote,
  parseExecutableQuote,
  signTakerControl,
  verifyTakerControl,
  type FetchFn,
  type RawTextileQuote,
  type SubmitQuoteClients,
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

describe("execution opt-in flag", () => {
  it("is off by default and on only for explicit true or 1", () => {
    expect(isTextileExecutionEnabled({})).toBe(false);
    expect(isTextileExecutionEnabled({ [TEXTILE_EXECUTION_ENV]: "false" })).toBe(false);
    expect(isTextileExecutionEnabled({ [TEXTILE_EXECUTION_ENV]: "yes" })).toBe(false);
    expect(isTextileExecutionEnabled({ [TEXTILE_EXECUTION_ENV]: "true" })).toBe(true);
    expect(isTextileExecutionEnabled({ [TEXTILE_EXECUTION_ENV]: "1" })).toBe(true);
  });

  it("submitQuote throws with the flag off and broadcasts nothing", async () => {
    delete process.env[TEXTILE_EXECUTION_ENV];
    const account = privateKeyToAccount(generatePrivateKey());
    const quote = parseExecutableQuote(fixtureExecutable(account.address), {
      usdtAmount: "1.50",
    });
    const sendTransaction = vi.fn(async () => "0xdeadbeef" as Hex);
    const client = new TextileQuoteClient({
      fetchFn: mockFetchReturning({}),
    });
    await expect(
      client.submitQuote({
        quote,
        account,
        clients: {
          walletClient: { sendTransaction } as unknown as SubmitQuoteClients["walletClient"],
          publicClient: {} as unknown as SubmitQuoteClients["publicClient"],
          verifyTaggedTxFn: async () => ({ tagged: true, codes: [] }),
        },
      }),
    ).rejects.toThrow(/execution is disabled/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

/** Documented firm quote envelope (docs: RFQ endpoints, "The quote"). */
function fixtureExecutable(taker: Address): RawTextileQuote {
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  return {
    data: {
      rfqId: "rfq_fixture_1",
      claimToken: "rfqc_fixture",
      status: "quoted",
      quote: {
        sellAmount: "1500000",
        buyAmount: "2400000",
        feeAmount: "1500",
        takerPays: "1500000",
        expiresAt: future(60_000),
        orderDeadline: future(90_000),
        reactor: TEXTILE_LIMIT_ORDER_REACTOR,
        taker,
      },
      transactions: {
        approval: {
          to: USDT_ADDRESS,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [TEXTILE_LIMIT_ORDER_REACTOR, 1500000n],
          }),
          value: "0",
          chainId: 42220,
        },
        swap: {
          to: TEXTILE_LIMIT_ORDER_REACTOR,
          data: "0x1234abcd",
          value: "0",
          chainId: 42220,
        },
      },
    } as unknown as RawTextileQuote["data"],
  };
}

describe("parseExecutableQuote", () => {
  it("parses the documented envelope into executable form", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const quote = parseExecutableQuote(fixtureExecutable(account.address), {
      usdtAmount: "1.50",
    });
    expect(quote.rfqId).toBe("rfq_fixture_1");
    expect(quote.claimToken).toBe("rfqc_fixture");
    expect(quote.reactor).toBe(TEXTILE_LIMIT_ORDER_REACTOR);
    expect(quote.takerPaysRaw).toBe(1500000n);
    expect(quote.buyAmountRaw).toBe(2400000n);
    expect(quote.normalized.idrxAmount).toBe("24000");
    expect(quote.transactions.swap.to).toBe(TEXTILE_LIMIT_ORDER_REACTOR);
  });

  it("throws a typed no quote error on a no_quote envelope", () => {
    expect(() =>
      parseExecutableQuote(
        { data: { status: "no_quote", reason: "no_valid_quote" } },
        { usdtAmount: "0.10" },
      ),
    ).toThrow(TextileNoQuoteError);
  });

  it("refuses a reactor other than the known LimitOrderReactor", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = fixtureExecutable(account.address);
    (raw.data as { quote: { reactor: string } }).quote.reactor =
      "0x000000000000000000000000000000000000dEaD";
    expect(() => parseExecutableQuote(raw, { usdtAmount: "1.50" })).toThrow(
      /not the known Celo LimitOrderReactor/,
    );
  });
});

describe("submitQuote with the flag on (stub chain clients)", () => {
  function stubClients(allowance: bigint) {
    const sent: { to: string; data: string; value: bigint }[] = [];
    const simulated: string[] = [];
    let counter = 0;
    const walletClient = {
      sendTransaction: vi.fn(
        async (args: { to: string; data: string; value: bigint }) => {
          sent.push(args);
          counter += 1;
          return `0xhash${counter}` as Hex;
        },
      ),
    };
    const publicClient = {
      call: vi.fn(async (args: { data: string }) => {
        simulated.push(args.data);
        return {};
      }),
      readContract: vi.fn(async () => allowance),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    };
    const clients = {
      walletClient: walletClient as unknown as SubmitQuoteClients["walletClient"],
      publicClient: publicClient as unknown as SubmitQuoteClients["publicClient"],
      verifyTaggedTxFn: async () => ({
        tagged: true,
        codes: ["celo_f58da6359b7f"],
      }),
    };
    return { sent, simulated, walletClient, publicClient, clients };
  }

  function flowFetch() {
    return vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/submit")
          ? { data: { status: "submitted" } }
          : { data: { status: "submitted" } },
      text: async () => "{}",
    })) as unknown as FetchFn;
  }

  it("approves then swaps when the allowance is zero, simulating tagged bytes first", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const quote = parseExecutableQuote(fixtureExecutable(account.address), {
      usdtAmount: "1.50",
    });
    const { sent, simulated, clients } = stubClients(0n);
    const client = new TextileQuoteClient({
      fetchFn: flowFetch(),
      executionEnabled: true,
    });
    const result = await client.submitQuote({ quote, account, clients });
    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe(USDT_ADDRESS); // approval
    expect(sent[1].to).toBe(TEXTILE_LIMIT_ORDER_REACTOR); // swap
    expect(result.approvalHashes).toHaveLength(1);
    expect(result.swapHash).toBe("0xhash2");
    expect(result.rfqStatus).toBe("submitted");
    // Every simulation carried the attribution suffix on the calldata.
    expect(simulated.length).toBeGreaterThan(0);
    for (const data of simulated) {
      expect(data).toContain(getAttributionSuffix().slice(2));
    }
  });

  it("skips the approval when the allowance already covers takerPays", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const quote = parseExecutableQuote(fixtureExecutable(account.address), {
      usdtAmount: "1.50",
    });
    const { sent, clients } = stubClients(1500000n);
    const client = new TextileQuoteClient({
      fetchFn: flowFetch(),
      executionEnabled: true,
    });
    const result = await client.submitQuote({ quote, account, clients });
    expect(sent).toHaveLength(1);
    expect(result.approvalHashes).toHaveLength(0);
  });

  it("resets a nonzero short allowance to zero before approving (USDT style)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const quote = parseExecutableQuote(fixtureExecutable(account.address), {
      usdtAmount: "1.50",
    });
    const { sent, clients } = stubClients(5n);
    const client = new TextileQuoteClient({
      fetchFn: flowFetch(),
      executionEnabled: true,
    });
    const result = await client.submitQuote({ quote, account, clients });
    expect(sent).toHaveLength(3);
    expect(result.approvalHashes).toHaveLength(2);
  });

  it("refuses an expired quote before broadcasting anything", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = fixtureExecutable(account.address);
    (raw.data as { quote: { expiresAt: string } }).quote.expiresAt =
      new Date(Date.now() - 1000).toISOString();
    const quote = parseExecutableQuote(raw, { usdtAmount: "1.50" });
    const { sent, clients } = stubClients(0n);
    const client = new TextileQuoteClient({
      fetchFn: flowFetch(),
      executionEnabled: true,
    });
    await expect(client.submitQuote({ quote, account, clients })).rejects.toThrow(
      /accept cutoff/,
    );
    expect(sent).toHaveLength(0);
  });
});

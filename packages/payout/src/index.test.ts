import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  erc20Abi,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAttributionSuffix } from "@tanda/wallet";
import { IDRX_ADDRESS, USDT_ADDRESS } from "@tanda/money";
import {
  AGENT_ADDRESS,
  PAYOUT_EXECUTION_ENV,
  TREASURY_ADDRESS,
  PayoutPreflightError,
  buildPayoutCalldata,
  buildPayoutTx,
  executePayout,
  isPayoutExecutionEnabled,
  runPayoutPreflight,
  type InboundTokenTransfer,
  type PayoutChainReader,
  type PayoutClients,
} from "./index.js";

/** The treasury address as an Account stub: executePayout only reads .address. */
const treasuryAccount = { address: TREASURY_ADDRESS } as unknown as Account;

function freshRecipient(): Address {
  return privateKeyToAccount(generatePrivateKey()).address;
}

/**
 * Stub chain reader. Defaults mirror the real treasury state after the
 * settled conversion (EVIDENCE.md section 14): T holds 18,339.92 IDRX,
 * recipients hold nothing and have no inbound history.
 */
function stubChain(
  overrides: {
    treasuryIdrx?: bigint;
    inbound?: InboundTokenTransfer[];
  } = {},
) {
  const simulate = vi.fn(async () => {});
  const chain: PayoutChainReader = {
    idrxBalanceOf: vi.fn(async (owner: Address) =>
      owner === TREASURY_ADDRESS ? (overrides.treasuryIdrx ?? 1833992n) : 0n,
    ),
    celoBalanceOf: vi.fn(async () => 0n),
    inboundTransfersTo: vi.fn(async () => overrides.inbound ?? []),
    simulate,
  };
  return { chain, simulate };
}

function stubClients(chain: PayoutChainReader) {
  const sendTransaction = vi.fn(
    async () => "0xpayouttxhash" as unknown as Hex,
  );
  const clients: PayoutClients = {
    walletClient: {
      sendTransaction,
    } as unknown as PayoutClients["walletClient"],
    publicClient: {
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    } as unknown as PayoutClients["publicClient"],
    chain,
    verifyTaggedTxFn: async () => ({
      tagged: true,
      codes: ["celo_f58da6359b7f"],
    }),
  };
  return { clients, sendTransaction };
}

describe("execution opt-in flag", () => {
  it("is off by default and on only for explicit true or 1", () => {
    expect(isPayoutExecutionEnabled({})).toBe(false);
    expect(isPayoutExecutionEnabled({ [PAYOUT_EXECUTION_ENV]: "false" })).toBe(false);
    expect(isPayoutExecutionEnabled({ [PAYOUT_EXECUTION_ENV]: "yes" })).toBe(false);
    expect(isPayoutExecutionEnabled({ [PAYOUT_EXECUTION_ENV]: "true" })).toBe(true);
    expect(isPayoutExecutionEnabled({ [PAYOUT_EXECUTION_ENV]: "1" })).toBe(true);
  });
});

describe("calldata and transaction summary", () => {
  it("encodes an ERC-20 transfer of the IDRX amount to the recipient", () => {
    const recipient = freshRecipient();
    const data = buildPayoutCalldata(recipient, 1500000n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([recipient, 1500000n]);
  });

  it("builds the summary with the exact tagged bytes (calldata plus attribution suffix)", () => {
    const recipient = freshRecipient();
    const tx = buildPayoutTx({ recipient, amountRaw: 1500000n });
    expect(tx.from).toBe(TREASURY_ADDRESS);
    expect(tx.to).toBe(IDRX_ADDRESS);
    expect(tx.chainId).toBe(42220);
    expect(tx.amountIDRX).toBe("15000");
    expect(tx.taggedData).toBe(
      `${tx.data}${getAttributionSuffix().slice(2)}` as Hex,
    );
  });
});

describe("pre-flight checks", () => {
  it("passes for a fresh recipient with a covered amount", async () => {
    const { chain } = stubChain();
    const preflight = await runPayoutPreflight({
      recipient: freshRecipient(),
      amountRaw: 1500000n,
      chain,
    });
    expect(preflight.ok).toBe(true);
    expect(preflight.checks.every((c) => c.ok)).toBe(true);
    expect(preflight.treasuryIdrxBalanceRaw).toBe(1833992n);
    expect(preflight.priorInboundFromUs).toEqual([]);
  });

  it("refuses the agent wallet as recipient (paying ourselves)", async () => {
    const { chain } = stubChain();
    const preflight = await runPayoutPreflight({
      recipient: AGENT_ADDRESS,
      amountRaw: 100n,
      chain,
    });
    expect(preflight.ok).toBe(false);
    expect(
      preflight.checks.find((c) => c.name === "recipient_not_agent")?.ok,
    ).toBe(false);
  });

  it("refuses the treasury wallet as recipient", async () => {
    const { chain } = stubChain();
    const preflight = await runPayoutPreflight({
      recipient: TREASURY_ADDRESS,
      amountRaw: 100n,
      chain,
    });
    expect(preflight.ok).toBe(false);
    expect(
      preflight.checks.find((c) => c.name === "recipient_not_treasury")?.ok,
    ).toBe(false);
  });

  it("refuses an amount above the treasury IDRX balance", async () => {
    const { chain } = stubChain();
    const preflight = await runPayoutPreflight({
      recipient: freshRecipient(),
      amountRaw: 2000000n, // 20,000 IDRX > 18,339.92 IDRX float
      chain,
    });
    expect(preflight.ok).toBe(false);
    expect(
      preflight.checks.find((c) => c.name === "treasury_balance_covers")?.ok,
    ).toBe(false);
  });

  it("refuses a zero amount", async () => {
    const { chain } = stubChain();
    const preflight = await runPayoutPreflight({
      recipient: freshRecipient(),
      amountRaw: 0n,
      chain,
    });
    expect(preflight.ok).toBe(false);
    expect(
      preflight.checks.find((c) => c.name === "amount_positive")?.ok,
    ).toBe(false);
  });

  it("refuses when the recipient already received IDRX from the treasury", async () => {
    const recipient = freshRecipient();
    const prior: InboundTokenTransfer = {
      token: IDRX_ADDRESS,
      tokenSymbol: "IDRX",
      from: TREASURY_ADDRESS,
      valueRaw: 100n,
      transactionHash: "0xprior" as Hex,
      blockNumber: 1n,
    };
    const { chain } = stubChain({ inbound: [prior] });
    const preflight = await runPayoutPreflight({
      recipient,
      amountRaw: 100n,
      chain,
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.priorInboundFromUs).toEqual([prior]);
    expect(
      preflight.checks.find((c) => c.name === "no_prior_inbound_from_us")?.ok,
    ).toBe(false);
  });

  it("refuses when the recipient already received USDT from the agent wallet", async () => {
    const prior: InboundTokenTransfer = {
      token: USDT_ADDRESS,
      tokenSymbol: "USDT",
      from: AGENT_ADDRESS,
      valueRaw: 100000n,
      transactionHash: "0xprior" as Hex,
      blockNumber: 1n,
    };
    const { chain } = stubChain({ inbound: [prior] });
    const preflight = await runPayoutPreflight({
      recipient: freshRecipient(),
      amountRaw: 100n,
      chain,
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.priorInboundFromUs).toEqual([prior]);
  });

  it("ignores inbound transfers from unrelated wallets", async () => {
    const prior: InboundTokenTransfer = {
      token: IDRX_ADDRESS,
      tokenSymbol: "IDRX",
      from: freshRecipient(),
      valueRaw: 100n,
      transactionHash: "0xother" as Hex,
      blockNumber: 1n,
    };
    const { chain } = stubChain({ inbound: [prior] });
    const preflight = await runPayoutPreflight({
      recipient: freshRecipient(),
      amountRaw: 100n,
      chain,
    });
    expect(preflight.ok).toBe(true);
    expect(preflight.priorInboundFromUs).toEqual([]);
  });
});

describe("executePayout", () => {
  it("dry run (the default) simulates the tagged bytes and broadcasts nothing", async () => {
    const { chain, simulate } = stubChain();
    const { clients, sendTransaction } = stubClients(chain);
    const recipient = freshRecipient();
    const result = await executePayout({
      account: treasuryAccount,
      recipient,
      amountIDRX: "15000",
      clients,
    });
    expect(result.mode).toBe("dry-run");
    if (result.mode !== "dry-run") throw new Error("expected dry run");
    expect(result.tx.amountRaw).toBe(1500000n);
    expect(result.preflight.ok).toBe(true);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(simulate).toHaveBeenCalledTimes(1);
    const simArgs = simulate.mock.calls[0] as unknown as [
      { to: Address; data: Hex },
    ];
    expect(simArgs[0].to).toBe(IDRX_ADDRESS);
    expect(simArgs[0].data).toBe(result.tx.taggedData);
    expect(simArgs[0].data.endsWith(getAttributionSuffix().slice(2))).toBe(true);
  });

  it("live request with the flag off throws before any chain read and broadcasts nothing", async () => {
    const { chain, simulate } = stubChain();
    const { clients, sendTransaction } = stubClients(chain);
    await expect(
      executePayout({
        account: treasuryAccount,
        recipient: freshRecipient(),
        amountIDRX: "15000",
        dryRun: false,
        env: {},
        clients,
      }),
    ).rejects.toThrow(/execution is disabled/);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
    expect(chain.idrxBalanceOf).not.toHaveBeenCalled();
  });

  it("live send with the flag on broadcasts once through the tagged client and returns the hash", async () => {
    const { chain } = stubChain();
    const { clients, sendTransaction } = stubClients(chain);
    const recipient = freshRecipient();
    const result = await executePayout({
      account: treasuryAccount,
      recipient,
      amountIDRX: "15000",
      dryRun: false,
      executionEnabled: true,
      clients,
    });
    expect(result.mode).toBe("live");
    if (result.mode !== "live") throw new Error("expected live");
    expect(result.txHash).toBe("0xpayouttxhash");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const sent = sendTransaction.mock.calls[0] as unknown as [
      { to: Address; data: Hex; value: bigint },
    ];
    expect(sent[0].to).toBe(IDRX_ADDRESS);
    // The tagged client appends the suffix itself, so the send carries
    // the base calldata (same contract as Textile's submitQuote).
    expect(sent[0].data).toBe(result.tx.data);
    expect(sent[0].value).toBe(0n);
  });

  it("refuses an account that is not the treasury wallet", async () => {
    const { chain } = stubChain();
    const { clients } = stubClients(chain);
    const other = privateKeyToAccount(generatePrivateKey());
    await expect(
      executePayout({
        account: other,
        recipient: freshRecipient(),
        amountIDRX: "100",
        clients,
      }),
    ).rejects.toThrow(/treasury wallet/);
  });

  it("throws the pre-flight error (and simulates nothing) when a check fails", async () => {
    const { chain, simulate } = stubChain();
    const { clients, sendTransaction } = stubClients(chain);
    await expect(
      executePayout({
        account: treasuryAccount,
        recipient: AGENT_ADDRESS,
        amountIDRX: "100",
        clients,
      }),
    ).rejects.toBeInstanceOf(PayoutPreflightError);
    expect(simulate).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects IDRX amounts with more than 2 decimal places instead of truncating", async () => {
    const { chain } = stubChain();
    const { clients } = stubClients(chain);
    await expect(
      executePayout({
        account: treasuryAccount,
        recipient: freshRecipient(),
        amountIDRX: "1.001",
        clients,
      }),
    ).rejects.toThrow(/more than 2 decimal places/);
  });
});

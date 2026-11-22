import {
  encodeFunctionData,
  erc20Abi,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import {
  createCeloPublicClient,
  createTaggedWalletClient,
  getAttributionSuffix,
  verifyTaggedTx,
  type TaggedWalletClient,
} from "@tanda/wallet";
import {
  IDRX_ADDRESS,
  USDT_ADDRESS,
  assertIDRXPrecision,
  formatIDRX,
  parseIDRX,
} from "@tanda/money";

/**
 * IDRX payout leg for Tanda: the desk pays a freelancer out of the
 * treasury (kas) wallet, in IDRX, after an order has settled in USDT
 * and been converted over Textile FX.
 *
 * Placement: this is a package, not a desk server route, for the same
 * reason ERC-8004 registration lives in packages/identity. The desk
 * server's job ends at order settlement (Self gate, x402 payment,
 * handler). Paying out is an operator step run from the treasury after
 * delivery is accepted, under Duan's notify-first rule: he is told the
 * exact transaction in advance and approves it before anything is sent.
 * A library plus CLI (src/payout.ts) matches that operating model; an
 * HTTP route that moves money would not.
 *
 * Safety shape, mirroring the two patterns already proven in this repo:
 * - Dry run by default, exactly like packages/identity: executePayout
 *   builds the transaction, runs every pre-flight check, simulates the
 *   exact tagged bytes, and returns the full would-be summary. Nothing
 *   is broadcast unless the caller passes dryRun: false.
 * - Broadcasting additionally sits behind an explicit opt-in flag,
 *   exactly like Textile execution: PAYOUT_EXECUTION_ENABLED must be
 *   "true" or "1" (or the executionEnabled option must be set) before
 *   a live send is even attempted. With the flag off, a live request
 *   throws before any chain read and can never broadcast.
 *
 * Every send goes through createTaggedWalletClient in @tanda/wallet,
 * so the payout carries the Loops House attribution code
 * (celo_f58da6359b7f) by construction, and is verifyTx checked after
 * landing. All amount handling goes through @tanda/money: IDRX has 2
 * decimals, and this module never parses a token amount itself.
 */

export const CELO_CHAIN_ID = 42220;

/** The buyer agent wallet (A). Payouts never go to it: it is us. */
export const AGENT_ADDRESS =
  "0xed328f847eF33f35148513DCEFB10069FcE53725" as const;

/**
 * The treasury (kas) wallet (T). Holds the IDRX payout float
 * (18,339.92 IDRX from the settled conversion, EVIDENCE.md section 14)
 * and is the only wallet a payout may be sent from. Its key lives only
 * in tanda/.env as TREASURY_PRIVATE_KEY.
 */
export const TREASURY_ADDRESS =
  "0x7D6bc7c0DF2d312e6137E78F99107db6Aff1d830" as const;

/** The environment variable that opts in to live payout broadcasts. Default: off. */
export const PAYOUT_EXECUTION_ENV = "PAYOUT_EXECUTION_ENABLED";

/** True only when the payout execution opt-in is explicitly switched on. */
export function isPayoutExecutionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = (env[PAYOUT_EXECUTION_ENV] ?? "").toLowerCase();
  return value === "true" || value === "1";
}

export function celoscanTxUrl(hash: Hash): string {
  return `https://celoscan.io/tx/${hash}`;
}

export function celoscanAddressUrl(address: Address): string {
  return `https://celoscan.io/address/${address}`;
}

/** One inbound token transfer to a wallet, decoded from a Transfer log. */
export interface InboundTokenTransfer {
  token: Address;
  tokenSymbol: "IDRX" | "USDT";
  from: Address;
  valueRaw: bigint;
  transactionHash: Hash;
  blockNumber: bigint;
}

/**
 * The chain reads the payout path needs, behind an interface so tests
 * inject stubs and no test ever touches the network. The production
 * implementation is createPayoutChainReader below.
 */
export interface PayoutChainReader {
  /** IDRX balanceOf(owner), raw units (2 decimals). */
  idrxBalanceOf(owner: Address): Promise<bigint>;
  /** Native CELO balance, wei. */
  celoBalanceOf(owner: Address): Promise<bigint>;
  /**
   * Every IDRX and USDT Transfer TO the recipient, from `fromBlock`
   * (default 0, the full history) to the current head. The pre-funding
   * check filters this list for transfers sent by our own wallets.
   */
  inboundTransfersTo(
    recipient: Address,
    fromBlock?: bigint,
  ): Promise<InboundTokenTransfer[]>;
  /**
   * Simulate a call with the exact bytes given (the caller passes the
   * tagged calldata). Resolves on success, throws on revert.
   */
  simulate(args: {
    account: Account;
    to: Address;
    data: Hex;
    value: bigint;
  }): Promise<void>;
}

/**
 * Block range per eth_getLogs call in the history scan: 5,000 blocks,
 * the maximum range the public Celo RPC (forno) accepts per call.
 * A genesis-to-head scan at this chunk size is over 16,000 calls, so
 * on the public RPC operators should pass the floor block described
 * in createPayoutChainReader; the full-history default stays correct
 * on any RPC, just slow.
 */
export const LOG_SCAN_CHUNK_BLOCKS = 5_000n;

const SCANNED_TOKENS: { address: Address; symbol: "IDRX" | "USDT" }[] = [
  { address: IDRX_ADDRESS, symbol: "IDRX" },
  { address: USDT_ADDRESS, symbol: "USDT" },
];

/**
 * Production chain reader over a viem public client.
 *
 * The history scan walks Transfer logs in chunks of
 * LOG_SCAN_CHUNK_BLOCKS so it stays inside public RPC range limits.
 * Callers who know a safe floor block (for example the block the agent
 * wallet was funded at: neither Tanda wallet has any onchain existence
 * before it, so no transfer from us can predate it) should pass
 * `fromBlock` to shorten the scan; the default scans from genesis,
 * which is correct but slow on the public RPC. The evidence pack's
 * third-party verification step independently re-checks the full
 * inbound history on CeloScan, so the floor is an operator
 * convenience, never the only line of defence.
 */
export function createPayoutChainReader(
  publicClient: PublicClient,
): PayoutChainReader {
  return {
    async idrxBalanceOf(owner) {
      return publicClient.readContract({
        address: IDRX_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
    },
    async celoBalanceOf(owner) {
      return publicClient.getBalance({ address: owner });
    },
    async inboundTransfersTo(recipient, fromBlock = 0n) {
      const head = await publicClient.getBlockNumber();
      const transferEvent = erc20Abi.find(
        (item) => item.type === "event" && item.name === "Transfer",
      );
      if (!transferEvent || transferEvent.type !== "event") {
        throw new Error("ERC-20 Transfer event not found in the ABI.");
      }
      const found: InboundTokenTransfer[] = [];
      for (const token of SCANNED_TOKENS) {
        for (
          let start = fromBlock;
          start <= head;
          start += LOG_SCAN_CHUNK_BLOCKS
        ) {
          const end =
            start + LOG_SCAN_CHUNK_BLOCKS - 1n > head
              ? head
              : start + LOG_SCAN_CHUNK_BLOCKS - 1n;
          const logs = await publicClient.getLogs({
            address: token.address,
            event: transferEvent,
            args: { to: recipient },
            fromBlock: start,
            toBlock: end,
          });
          for (const log of logs) {
            const { from, value } = log.args;
            if (!from || value === undefined || !log.transactionHash) {
              continue;
            }
            found.push({
              token: token.address,
              tokenSymbol: token.symbol,
              from,
              valueRaw: value,
              transactionHash: log.transactionHash,
              blockNumber: log.blockNumber ?? 0n,
            });
          }
        }
      }
      return found.sort((a, b) =>
        a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
      );
    },
    async simulate(args) {
      await publicClient.call({
        account: args.account,
        to: args.to,
        data: args.data,
        value: args.value,
      });
    },
  };
}

/** One named pre-flight check with its outcome and the evidence behind it. */
export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PayoutPreflight {
  ok: boolean;
  recipient: Address;
  /** IDRX raw units the payout would send. */
  amountRaw: bigint;
  checks: PreflightCheck[];
  treasuryIdrxBalanceRaw: bigint;
  recipientIdrxBalanceRaw: bigint;
  recipientCeloBalanceWei: bigint;
  /** Inbound transfers to the recipient that came from A or T. Must be empty. */
  priorInboundFromUs: InboundTokenTransfer[];
}

/** Thrown when any pre-flight check fails. Carries the full report. */
export class PayoutPreflightError extends Error {
  preflight: PayoutPreflight;
  constructor(preflight: PayoutPreflight) {
    const failed = preflight.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name}: ${c.detail}`)
      .join("; ");
    super(`Payout pre-flight failed. Refusing to proceed. ${failed}`);
    this.name = "PayoutPreflightError";
    this.preflight = preflight;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Run every pre-flight check for a payout and report all of them (no
 * short circuit: the operator sees the complete picture, and the
 * evidence pack's pre-funding statement rests on this report).
 *
 * Checks:
 * 1. amount_positive: the amount is above zero.
 * 2. recipient_not_agent: the recipient is not the agent wallet A.
 *    A payout to A would be us paying ourselves.
 * 3. recipient_not_treasury: the recipient is not the treasury T.
 *    Same problem, other pocket.
 * 4. treasury_balance_covers: T's live IDRX balance covers the amount.
 * 5. no_prior_inbound_from_us: the recruitment rule, operationalized.
 *    The freelancer payout must be the first funds we ever send their
 *    wallet, so any earlier IDRX or USDT transfer from A or T to the
 *    recipient (found by scanning the recipient's inbound Transfer
 *    history) refuses the payout. The recipient's IDRX and CELO
 *    balances are read and reported either way.
 */
export async function runPayoutPreflight(input: {
  recipient: Address;
  /** IDRX raw units. */
  amountRaw: bigint;
  chain: PayoutChainReader;
  treasury?: Address;
  agent?: Address;
  /** Floor block for the inbound history scan. Default: full history. */
  scanFromBlock?: bigint;
}): Promise<PayoutPreflight> {
  const treasury = input.treasury ?? TREASURY_ADDRESS;
  const agent = input.agent ?? AGENT_ADDRESS;
  const { recipient, amountRaw, chain } = input;

  const [treasuryIdrxBalanceRaw, recipientIdrxBalanceRaw, recipientCeloBalanceWei, inbound] =
    await Promise.all([
      chain.idrxBalanceOf(treasury),
      chain.idrxBalanceOf(recipient),
      chain.celoBalanceOf(recipient),
      chain.inboundTransfersTo(recipient, input.scanFromBlock),
    ]);
  const priorInboundFromUs = inbound.filter(
    (t) => sameAddress(t.from, agent) || sameAddress(t.from, treasury),
  );

  const checks: PreflightCheck[] = [
    {
      name: "amount_positive",
      ok: amountRaw > 0n,
      detail:
        amountRaw > 0n
          ? `Amount is ${formatIDRX(amountRaw)} IDRX (${amountRaw} raw units).`
          : "Amount is zero or negative. A payout must move a positive amount.",
    },
    {
      name: "recipient_not_agent",
      ok: !sameAddress(recipient, agent),
      detail: sameAddress(recipient, agent)
        ? `Recipient ${recipient} IS the agent wallet. Paying it would be paying ourselves.`
        : `Recipient ${recipient} is not the agent wallet ${agent}.`,
    },
    {
      name: "recipient_not_treasury",
      ok: !sameAddress(recipient, treasury),
      detail: sameAddress(recipient, treasury)
        ? `Recipient ${recipient} IS the treasury wallet. Paying it would move the float in a circle.`
        : `Recipient ${recipient} is not the treasury wallet ${treasury}.`,
    },
    {
      name: "treasury_balance_covers",
      ok: treasuryIdrxBalanceRaw >= amountRaw,
      detail:
        treasuryIdrxBalanceRaw >= amountRaw
          ? `Treasury holds ${formatIDRX(treasuryIdrxBalanceRaw)} IDRX, covering the ${formatIDRX(amountRaw)} IDRX payout.`
          : `Treasury holds ${formatIDRX(treasuryIdrxBalanceRaw)} IDRX, short of the ${formatIDRX(amountRaw)} IDRX payout. Top up and convert first.`,
    },
    {
      name: "no_prior_inbound_from_us",
      ok: priorInboundFromUs.length === 0,
      detail:
        priorInboundFromUs.length === 0
          ? `No prior IDRX or USDT transfer from the agent or treasury wallet to ${recipient} in the scanned history. This payout would be the first funds we ever send it.`
          : `Found ${priorInboundFromUs.length} prior transfer(s) from our wallets to ${recipient} (first: ${priorInboundFromUs[0].tokenSymbol} in tx ${priorInboundFromUs[0].transactionHash}). The payout would NOT be the first funds we send this wallet, which the track record goal forbids presenting as a first payout.`,
    },
  ];

  return {
    ok: checks.every((c) => c.ok),
    recipient,
    amountRaw,
    checks,
    treasuryIdrxBalanceRaw,
    recipientIdrxBalanceRaw,
    recipientCeloBalanceWei,
    priorInboundFromUs,
  };
}

/** Print a pre-flight report in a stable, greppable shape. */
export function formatPreflight(preflight: PayoutPreflight): string {
  const lines = [
    `Pre-flight checks for paying ${formatIDRX(preflight.amountRaw)} IDRX to ${preflight.recipient}:`,
    ...preflight.checks.map(
      (c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`,
    ),
    `  treasury IDRX balance:  ${formatIDRX(preflight.treasuryIdrxBalanceRaw)} IDRX`,
    `  recipient IDRX balance: ${formatIDRX(preflight.recipientIdrxBalanceRaw)} IDRX`,
    `  recipient CELO balance: ${preflight.recipientCeloBalanceWei} wei`,
    `  verdict: ${preflight.ok ? "PASS" : "REFUSED"}`,
  ];
  return lines.join("\n");
}

/** The exact ERC-20 transfer(recipient, amount) calldata for the IDRX token. Pure. */
export function buildPayoutCalldata(recipient: Address, amountRaw: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, amountRaw],
  });
}

export interface PayoutTxSummary {
  chainId: number;
  /** Sender: always the treasury wallet. */
  from: Address;
  /** Contract the transaction is sent to: the IDRX token. */
  to: Address;
  recipient: Address;
  /** IDRX raw units (2 decimals). */
  amountRaw: bigint;
  /** Human readable IDRX amount, from @tanda/money. */
  amountIDRX: string;
  /** Calldata before the attribution suffix. */
  data: Hex;
  /** The exact bytes simulated, and the bytes the tagged client sends: calldata plus the ERC-8021 suffix. */
  taggedData: Hex;
}

/** Build the full would-be payout transaction summary. Never sends. */
export function buildPayoutTx(input: {
  recipient: Address;
  /** IDRX raw units. */
  amountRaw: bigint;
  treasury?: Address;
}): PayoutTxSummary {
  const data = buildPayoutCalldata(input.recipient, input.amountRaw);
  const suffix = getAttributionSuffix();
  return {
    chainId: CELO_CHAIN_ID,
    from: input.treasury ?? TREASURY_ADDRESS,
    to: IDRX_ADDRESS,
    recipient: input.recipient,
    amountRaw: input.amountRaw,
    amountIDRX: formatIDRX(input.amountRaw),
    data,
    taggedData: `${data}${suffix.slice(2)}` as Hex,
  };
}

export interface PayoutClients {
  /** Must be the tagged client from @tanda/wallet for the treasury account. */
  walletClient: TaggedWalletClient;
  publicClient: PublicClient;
  chain: PayoutChainReader;
  /**
   * Post-broadcast tag check. Defaults to the real verifyTx wrapper from
   * @tanda/wallet; tests inject a stub because verifyTx reads the chain.
   */
  verifyTaggedTxFn?: (
    publicClient: PublicClient,
    hash: Hex,
  ) => Promise<{ tagged: boolean; codes: string[] }>;
}

export interface PayoutDryRunResult {
  mode: "dry-run";
  preflight: PayoutPreflight;
  tx: PayoutTxSummary;
  note: string;
}

export interface PayoutLiveResult {
  mode: "live";
  preflight: PayoutPreflight;
  tx: PayoutTxSummary;
  txHash: Hash;
}

export type PayoutResult = PayoutDryRunResult | PayoutLiveResult;

const DRY_RUN_NOTE =
  "Dry run: pre-flight passed and the exact tagged bytes simulated successfully, " +
  "but nothing was sent. A live payout needs dryRun: false AND the " +
  `${PAYOUT_EXECUTION_ENV} opt-in, plus Duan's advance approval under his ` +
  "notify-first rule for this project.";

/**
 * Execute (or dry run) one IDRX payout from the treasury to a
 * freelancer wallet.
 *
 * Default is a dry run: parse the amount through @tanda/money, run the
 * full pre-flight, build the tagged transfer, simulate the exact bytes,
 * and return the summary. Nothing is broadcast.
 *
 * A live send (dryRun: false) additionally requires the execution
 * opt-in (the executionEnabled option or PAYOUT_EXECUTION_ENABLED).
 * Without it this throws before any chain read, so a flag-off live
 * request cannot broadcast, exactly like Textile's submitQuote. With
 * the flag on, the flow is: pre-flight, simulate, broadcast through
 * the tagged wallet client, await the receipt, and verifyTx check
 * that the attribution tag landed (an untagged payout cannot be
 * credited and throws here).
 */
export async function executePayout(options: {
  /** The treasury account. Any other account is refused. */
  account: Account;
  recipient: Address;
  /** Human IDRX amount as a decimal string, for example "15000". Never a float. */
  amountIDRX: string;
  /** Default true. Live sends must opt in explicitly with dryRun: false. */
  dryRun?: boolean;
  /** Execution opt-in override. When omitted, the environment variable is read. */
  executionEnabled?: boolean;
  env?: Record<string, string | undefined>;
  /** Injected in tests and by the CLI. Defaults to real chain clients. */
  clients?: PayoutClients;
  rpcUrl?: string;
  /** Floor block for the pre-flight history scan. Default: full history. */
  scanFromBlock?: bigint;
}): Promise<PayoutResult> {
  assertIDRXPrecision(options.amountIDRX);
  const amountRaw = parseIDRX(options.amountIDRX);

  if (!sameAddress(options.account.address, TREASURY_ADDRESS)) {
    throw new Error(
      `Payouts are sent from the treasury wallet ${TREASURY_ADDRESS} only. ` +
        `The account given is ${options.account.address}. Refusing.`,
    );
  }

  const live = options.dryRun === false;
  if (live) {
    const enabled =
      options.executionEnabled ??
      isPayoutExecutionEnabled(options.env ?? process.env);
    if (!enabled) {
      throw new Error(
        "Payout execution is disabled: a live payout moves real IDRX on mainnet " +
          `and needs the explicit opt-in (${PAYOUT_EXECUTION_ENV}=true or the ` +
          "executionEnabled option), on top of dryRun: false. Dry runs only until then.",
      );
    }
  }

  const clients =
    options.clients ?? defaultClients(options.account, options.rpcUrl);
  const preflight = await runPayoutPreflight({
    recipient: options.recipient,
    amountRaw,
    chain: clients.chain,
    scanFromBlock: options.scanFromBlock,
  });
  if (!preflight.ok) {
    throw new PayoutPreflightError(preflight);
  }

  const tx = buildPayoutTx({ recipient: options.recipient, amountRaw });
  await clients.chain.simulate({
    account: options.account,
    to: tx.to,
    data: tx.taggedData,
    value: 0n,
  });

  if (!live) {
    return { mode: "dry-run", preflight, tx, note: DRY_RUN_NOTE };
  }

  const verifyFn =
    clients.verifyTaggedTxFn ??
    ((client: PublicClient, hash: Hex) => verifyTaggedTx(client as never, hash));
  const txHash = await clients.walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: 0n,
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`Payout transaction ${txHash} reverted on chain.`);
  }
  const tag = await verifyFn(clients.publicClient, txHash);
  if (!tag.tagged) {
    throw new Error(
      `Payout transaction ${txHash} landed WITHOUT the attribution tag. ` +
        "It cannot be credited; record it in the evidence log as untagged.",
    );
  }
  return { mode: "live", preflight, tx, txHash };
}

function defaultClients(account: Account, rpcUrl?: string): PayoutClients {
  const walletClient = createTaggedWalletClient({ account, rpcUrl });
  const publicClient = createCeloPublicClient(rpcUrl);
  return {
    walletClient,
    publicClient: publicClient as unknown as PublicClient,
    chain: createPayoutChainReader(publicClient as unknown as PublicClient),
  };
}

/** Print a dry run payout in a stable, greppable shape. */
export function formatPayoutDryRun(result: PayoutDryRunResult): string {
  const { tx, preflight } = result;
  return [
    "IDRX payout dry run",
    `  mode:       ${result.mode} (nothing sent)`,
    `  chainId:    ${tx.chainId}`,
    `  from:       ${tx.from} (treasury)`,
    `  to:         ${tx.to} (IDRX token contract)`,
    `  recipient:  ${tx.recipient}`,
    `  amount:     ${tx.amountIDRX} IDRX (${tx.amountRaw} raw units)`,
    `  data:       ${tx.data}`,
    `  taggedData: ${tx.taggedData}`,
    formatPreflight(preflight),
    `  note:       ${result.note}`,
  ].join("\n");
}

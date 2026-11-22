import { randomBytes } from "node:crypto";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  toHex,
  verifyTypedData,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  getAttributionSuffix,
  verifyTaggedTx,
  type TaggedWalletClient,
} from "@tanda/wallet";
import {
  IDRX_ADDRESS,
  USDT_ADDRESS,
  convertUSDTToIDRX,
  formatIDRX,
  formatUSDT,
  parseUSDT,
} from "@tanda/money";

/**
 * Textile FX quote client for the USDT to IDRX corridor on Celo.
 *
 * Source: Textile FX docs (https://fx-docs.textilecredit.com/), the RFQ
 * API v2 and its Authentication page.
 *
 * What the docs establish, and what this client is built on:
 * - IDRX / USDT is a live corridor on Celo (chain 42220).
 * - The RFQ endpoints need no login and no API key. A quote is bound to
 *   one `taker` wallet address. `POST /v2/rfq/preview` never needs a
 *   proof. A firm quote from `POST /v2/rfq/request` carries a
 *   `takerProof`: an EIP-712 `TakerControl` signature by the taker
 *   wallet, sent only when the API answers 401 with reason
 *   `proof_of_control_required` (a partner API key replaces the proof,
 *   and a verified proof earns a grant of about 12 hours). Token fields
 *   are addresses, not symbols, and amounts are raw units.
 * - All amount conversion goes through @tanda/money, the one module that
 *   knows USDT has 6 decimals and IDRX has 2. This client never parses a
 *   token amount itself; it only moves raw strings across the wire and
 *   hands them to that module.
 *
 * Execution: `submitQuote` settles a firm quote on chain, but only
 * behind an explicit opt-in. Unless the environment variable
 * TEXTILE_EXECUTION_ENABLED is set to "true" (or "1"), or the client is
 * constructed with `executionEnabled: true`, submitQuote throws and
 * nothing can settle. With the flag on it follows the documented RFQ
 * v2 execution flow: approve `takerPays` of the sell token to the
 * quote's reactor when the allowance is short (resetting a nonzero
 * allowance to zero first, USDT style), broadcast `transactions.swap`
 * from the taker wallet, then report the hash to POST /v2/rfq/{id}/submit
 * with the X-Rfq-Claim header. Every broadcast goes through the tagged
 * wallet client from @tanda/wallet, is simulated with the exact tagged
 * bytes before sending, and is verifyTx checked after landing.
 */

export const TEXTILE_API_BASE = "https://api.textilecredit.com/v2";
export const CELO_CHAIN_ID = 42220;
export const TEXTILE_LIMIT_ORDER_REACTOR =
  "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as const;

export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

export interface QuoteRequest {
  /** Human USDT amount as a decimal string, for example "1.50". Never a float. */
  usdtAmount: string;
  chainId?: number;
  sellToken?: Address;
  buyToken?: Address;
}

/** The wire body for POST /v2/rfq/preview and /v2/rfq/request. Amounts are raw unit strings. */
export function buildQuoteWireBody(input: QuoteRequest & { taker?: Address }) {
  return {
    chainId: input.chainId ?? CELO_CHAIN_ID,
    sellToken: input.sellToken ?? USDT_ADDRESS,
    buyToken: input.buyToken ?? IDRX_ADDRESS,
    sellAmount: parseUSDT(input.usdtAmount).toString(),
    ...(input.taker ? { taker: input.taker } : {}),
  };
}

/** Raw quote shape as served by the API. Extra fields are passed through untouched. */
export interface RawTextileQuote {
  id?: string;
  rfqId?: string;
  status?: string;
  sellAmount?: string;
  buyAmount?: string;
  takerPays?: string;
  reactor?: string;
  reason?: string;
  orderDeadline?: string;
  taker?: string;
  feeAmount?: string;
  feeBps?: number;
  expiresAt?: string | number;
  claimToken?: string;
  quote?: RawTextileQuote;
  data?: RawTextileQuote;
  [key: string]: unknown;
}

export interface NormalizedQuote {
  /** RFQ id when the API returned one (firm quotes), else null (previews may omit it). */
  id: string | null;
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  /** Human readable sell amount, USDT. */
  usdtAmount: string;
  usdtRaw: bigint;
  /** Human readable buy amount, IDRX, from the quote. */
  idrxAmount: string;
  idrxRaw: bigint;
  /** Effective rate, IDRX per 1 USDT, fee included, as a decimal string with 6 places. */
  effectiveRateIdrxPerUsdt: string;
  /** The same rate scaled by 10^6, the shape @tanda/money convertUSDTToIDRX expects. */
  rateScaled: bigint;
  feeAmount: string | null;
  feeBps: number | null;
  expiresAt: string | number | null;
  claimToken: string | null;
  raw: RawTextileQuote;
}

export class TextileNoQuoteError extends Error {
  constructor(message = "Textile FX returned no quote for this size.") {
    super(message);
    this.name = "TextileNoQuoteError";
  }
}

export class TextileApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Textile FX API error ${status}: ${body.slice(0, 200)}`);
    this.name = "TextileApiError";
    this.status = status;
    this.body = body;
  }
}

function unwrap(raw: RawTextileQuote): RawTextileQuote {
  const envelope =
    raw.data && typeof raw.data === "object" ? raw.data : raw;
  // Firm quote responses nest the amounts under `quote`; previews carry
  // them at the data level. Merge quote fields over the envelope so both
  // shapes read the same.
  if (envelope.quote && typeof envelope.quote === "object") {
    return { ...envelope, ...envelope.quote };
  }
  return envelope;
}

function isNoQuote(raw: RawTextileQuote): boolean {
  const status = (raw.status ?? "").toLowerCase();
  return status === "no_quote" || status === "noquote" || raw.buyAmount === "0";
}

/**
 * Normalize a raw API quote into desk terms. The effective rate is
 * computed in bigint only: rate = idrxHuman / usdtHuman, and with the raw
 * scales (IDRX 2 decimals, USDT 6) that is idrxRaw * 10^4 / usdtRaw,
 * scaled here by 10^6 for the rate string. The result is cross checked
 * against @tanda/money convertUSDTToIDRX, so a decimal slip anywhere in
 * the chain fails here instead of at payout time.
 */
export function normalizeQuote(
  rawInput: RawTextileQuote,
  input: QuoteRequest,
): NormalizedQuote {
  const raw = unwrap(rawInput);
  if (isNoQuote(raw)) {
    throw new TextileNoQuoteError();
  }
  if (!raw.buyAmount) {
    throw new TextileNoQuoteError(
      "Textile FX response carried no buyAmount. Treating it as no quote.",
    );
  }
  const usdtRaw = parseUSDT(input.usdtAmount);
  const idrxRaw = BigInt(raw.buyAmount);
  const rateScaled = (idrxRaw * 10n ** 10n) / usdtRaw;
  const check = convertUSDTToIDRX(usdtRaw, rateScaled, 6);
  if (check !== idrxRaw && check !== idrxRaw - 1n) {
    throw new Error(
      "Quote normalization failed its money module cross check. Refusing the quote.",
    );
  }
  return {
    id: raw.id ?? raw.rfqId ?? null,
    chainId: input.chainId ?? CELO_CHAIN_ID,
    sellToken: input.sellToken ?? USDT_ADDRESS,
    buyToken: input.buyToken ?? IDRX_ADDRESS,
    usdtAmount: formatUSDT(usdtRaw),
    usdtRaw,
    idrxAmount: formatIDRX(idrxRaw),
    idrxRaw,
    effectiveRateIdrxPerUsdt: formatUnits(rateScaled, 6),
    rateScaled,
    feeAmount: raw.feeAmount ?? null,
    feeBps: raw.feeBps ?? null,
    expiresAt: raw.expiresAt ?? null,
    claimToken: raw.claimToken ?? null,
    raw,
  };
}

/** True when the quote effective rate is at or above the desk floor rate for the job. */
export function meetsFloorRate(
  quote: NormalizedQuote,
  floorRateIdrxPerUsdt: string,
): boolean {
  const floorScaled = parseUnits(floorRateIdrxPerUsdt, 6);
  return quote.rateScaled >= floorScaled;
}

/** One ready-to-broadcast transaction as returned by the RFQ API. */
export interface TextileTxRequest {
  to: Address;
  data: Hex;
  value: string;
  chainId?: number;
}

/**
 * A firm quote in executable form: everything the settlement step needs,
 * parsed from the documented POST /v2/rfq/request response envelope
 * (`data.rfqId`, `data.claimToken`, `data.quote{...}`, `data.transactions`).
 * The claim token comes back exactly once; it authorizes submit, status
 * and cancel for this RFQ via the X-Rfq-Claim header.
 */
export interface ExecutableQuote {
  rfqId: string;
  claimToken: string;
  status: string;
  /** The reactor the taker approves and the swap executes against. */
  reactor: Address;
  /** Exactly what leaves the taker wallet, sell token raw units, fee included. */
  takerPaysRaw: bigint;
  /** What the taker receives, buy token raw units. */
  buyAmountRaw: bigint;
  feeAmountRaw: bigint | null;
  /** Accept cutoff: after this instant the API stops counting the quote. */
  expiresAt: string | null;
  /** Past this instant the signed orders themselves can no longer settle. */
  orderDeadline: string | null;
  transactions: {
    approval?: TextileTxRequest;
    swap: TextileTxRequest;
  };
  normalized: NormalizedQuote;
  raw: RawTextileQuote;
}

/**
 * Parse the full firm quote envelope into executable form. Throws
 * TextileNoQuoteError on a no_quote response and a plain Error when the
 * response is malformed (no swap calldata, no claim token, a reactor
 * other than the known Celo LimitOrderReactor): execution must never
 * improvise around a response it does not recognize.
 */
export function parseExecutableQuote(
  rawInput: RawTextileQuote,
  input: QuoteRequest,
): ExecutableQuote {
  const data =
    rawInput.data && typeof rawInput.data === "object"
      ? rawInput.data
      : rawInput;
  const status = (data.status ?? "").toLowerCase();
  if (status === "no_quote" || status === "noquote") {
    const reason =
      typeof data.reason === "string" ? data.reason : "no_valid_quote";
    throw new TextileNoQuoteError(
      `Textile FX returned no quote for this size (reason: ${reason}).`,
    );
  }
  const q =
    data.quote && typeof data.quote === "object" ? data.quote : data;
  const transactions = data.transactions as
    | { approval?: TextileTxRequest; swap?: TextileTxRequest }
    | undefined;
  if (!transactions?.swap?.to || !transactions?.swap?.data) {
    throw new Error(
      "Firm quote response carried no transactions.swap calldata. Refusing to execute.",
    );
  }
  const rfqId = data.rfqId ?? data.id;
  const claimToken = data.claimToken;
  if (!rfqId || !claimToken) {
    throw new Error(
      "Firm quote response carried no rfqId or claimToken. Refusing to execute.",
    );
  }
  const reactor = q.reactor as Address | undefined;
  if (!reactor) {
    throw new Error("Firm quote response carried no reactor. Refusing to execute.");
  }
  if (reactor.toLowerCase() !== TEXTILE_LIMIT_ORDER_REACTOR.toLowerCase()) {
    throw new Error(
      `Firm quote reactor ${reactor} is not the known Celo LimitOrderReactor ` +
        `${TEXTILE_LIMIT_ORDER_REACTOR}. Refusing to approve or execute against it.`,
    );
  }
  if (!q.takerPays || !q.buyAmount) {
    throw new Error(
      "Firm quote response carried no takerPays or buyAmount. Refusing to execute.",
    );
  }
  return {
    rfqId: String(rfqId),
    claimToken: String(claimToken),
    status: status || "quoted",
    reactor,
    takerPaysRaw: BigInt(q.takerPays),
    buyAmountRaw: BigInt(q.buyAmount),
    feeAmountRaw: q.feeAmount ? BigInt(q.feeAmount) : null,
    expiresAt: (q.expiresAt as string | undefined) ?? null,
    orderDeadline: (q.orderDeadline as string | undefined) ?? null,
    transactions: {
      ...(transactions.approval ? { approval: transactions.approval } : {}),
      swap: transactions.swap,
    },
    normalized: normalizeQuote(rawInput, input),
    raw: data,
  };
}

export interface TextileClientOptions {
  baseUrl?: string;
  fetchFn?: FetchFn;
  /** Optional partner API key. Quotes work without one; a key only replaces the taker proof. */
  apiKey?: string;
  /**
   * Execution opt-in override. When omitted, submitQuote reads the
   * TEXTILE_EXECUTION_ENABLED environment variable at call time.
   */
  executionEnabled?: boolean;
}

/** The environment variable that opts in to on-chain execution. Default: off. */
export const TEXTILE_EXECUTION_ENV = "TEXTILE_EXECUTION_ENABLED";

/** True only when the execution opt-in is explicitly switched on. */
export function isTextileExecutionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = (env[TEXTILE_EXECUTION_ENV] ?? "").toLowerCase();
  return value === "true" || value === "1";
}

/** The chain clients submitQuote broadcasts and verifies through. */
export interface SubmitQuoteClients {
  /** Must be the tagged client from @tanda/wallet for the taker account. */
  walletClient: TaggedWalletClient;
  publicClient: PublicClient;
  /**
   * Post-broadcast tag check. Defaults to the real verifyTx wrapper from
   * @tanda/wallet; tests inject a stub because verifyTx reads the chain.
   */
  verifyTaggedTxFn?: (
    publicClient: PublicClient,
    hash: Hex,
  ) => Promise<{ tagged: boolean; codes: string[] }>;
}

export interface SubmitQuoteResult {
  rfqId: string;
  /** Approval transactions broadcast, in order (empty when allowance already covered). */
  approvalHashes: Hex[];
  /** The settlement (swap) transaction hash. */
  swapHash: Hex;
  /** Status the API reported for the RFQ after the hash report, when readable. */
  rfqStatus: string | null;
}

export class TextileQuoteClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly apiKey?: string;
  private readonly executionEnabledOverride?: boolean;

  constructor(options: TextileClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? TEXTILE_API_BASE;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as FetchFn);
    this.apiKey = options.apiKey;
    this.executionEnabledOverride = options.executionEnabled;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /** Indicative quote. POST /v2/rfq/preview never needs a proof or a key. */
  async previewQuote(input: QuoteRequest): Promise<NormalizedQuote> {
    const res = await this.fetchFn(`${this.baseUrl}/rfq/preview`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildQuoteWireBody(input)),
    });
    if (!res.ok) {
      throw new TextileApiError(res.status, await res.text());
    }
    const raw = (await res.json()) as RawTextileQuote;
    return normalizeQuote(raw, input);
  }

  /**
   * The firm quote POST, shared by requestFirmQuote and
   * requestExecutableQuote. Follows the docs pattern exactly: send
   * unsigned first, and only when the API answers 401 with reason
   * proof_of_control_required, sign the TakerControl challenge with the
   * taker wallet and retry once. Returns the parsed response envelope.
   * A firm quote locks maker inventory for the taker until it expires;
   * it moves no funds by itself.
   */
  private async postFirmQuote(
    input: QuoteRequest & { account: Account },
  ): Promise<RawTextileQuote> {
    const body = buildQuoteWireBody({ ...input, taker: input.account.address });
    const send = async (extra: Record<string, unknown> = {}) => {
      return this.fetchFn(`${this.baseUrl}/rfq/request`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ...body, ...extra }),
      });
    };
    let res = await send();
    if (res.status === 401 && !this.apiKey) {
      const peek = (await res
        .json()
        .catch(() => null)) as { error?: { details?: { reason?: string } } } | null;
      if (peek?.error?.details?.reason === "proof_of_control_required") {
        const takerProof = await signTakerControl(
          input.account,
          input.chainId ?? CELO_CHAIN_ID,
        );
        res = await send({ takerProof });
      } else {
        throw new TextileApiError(401, JSON.stringify(peek ?? {}));
      }
    }
    if (!res.ok) {
      throw new TextileApiError(res.status, await res.text());
    }
    return (await res.json()) as RawTextileQuote;
  }

  /** Firm quote, normalized desk terms only. See postFirmQuote for the flow. */
  async requestFirmQuote(
    input: QuoteRequest & { account: Account },
  ): Promise<NormalizedQuote> {
    const raw = await this.postFirmQuote(input);
    return normalizeQuote(raw, input);
  }

  /**
   * Firm quote in executable form: the rfqId, claim token, reactor,
   * takerPays and the ready calldata (transactions.approval and
   * transactions.swap) that submitQuote broadcasts.
   */
  async requestExecutableQuote(
    input: QuoteRequest & { account: Account },
  ): Promise<ExecutableQuote> {
    const raw = await this.postFirmQuote(input);
    return parseExecutableQuote(raw, input);
  }

  private claimHeaders(claimToken: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Rfq-Claim": claimToken,
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /** Read an RFQ's status. Needs the claim token (or the partner key). */
  async getRfqStatus(quote: {
    rfqId: string;
    claimToken: string;
  }): Promise<string | null> {
    const res = await this.fetchFn(`${this.baseUrl}/rfq/${quote.rfqId}`, {
      method: "GET",
      headers: this.claimHeaders(quote.claimToken),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { status?: string };
      status?: string;
    };
    return body.data?.status ?? body.status ?? null;
  }

  /**
   * Settle a firm quote on chain, following the documented RFQ v2
   * execution flow. DISABLED unless execution was opted in (the
   * TEXTILE_EXECUTION_ENABLED environment variable or the client
   * option); with the flag off this throws before touching anything.
   *
   * With the flag on:
   * 1. Refuse when the quote's accept cutoff (expiresAt) has passed.
   * 2. Read the taker's sell token allowance to the quote's reactor.
   *    When short, broadcast the approval (a zero reset first when a
   *    nonzero allowance exists, USDT style, then the API's approval
   *    calldata or a locally built approve of takerPays) and wait for
   *    each receipt before continuing: the reactor pulls the sell
   *    token inside the swap, so the approval must land first.
   * 3. Re-check the cutoff, then broadcast transactions.swap exactly
   *    as returned, from the taker wallet.
   * 4. Report the swap hash to POST /v2/rfq/{id}/submit with the
   *    X-Rfq-Claim header and read the RFQ status back. Reporting is
   *    a courtesy per the docs (settlement reconciles from chain), so
   *    a failed report does not fail the settlement; the status read
   *    result is returned either way.
   *
   * Every broadcast goes through the injected tagged wallet client, is
   * simulated first with the exact bytes that will be sent (calldata
   * plus the ERC-8021 attribution suffix the tagged client appends),
   * and is verifyTx checked after landing: an untagged or reverted
   * transaction throws.
   */
  async submitQuote(input: {
    quote: ExecutableQuote;
    account: Account;
    clients: SubmitQuoteClients;
    sellToken?: Address;
  }): Promise<SubmitQuoteResult> {
    const enabled =
      this.executionEnabledOverride ?? isTextileExecutionEnabled();
    if (!enabled) {
      throw new Error(
        "Textile execution is disabled: submitQuote settles a real conversion " +
          `on mainnet and needs the explicit opt-in (${TEXTILE_EXECUTION_ENV}=true ` +
          "or the executionEnabled client option). Quotes only until then.",
      );
    }
    const { quote, account, clients } = input;
    const sellToken = input.sellToken ?? USDT_ADDRESS;
    const { walletClient, publicClient } = clients;
    const verifyFn =
      clients.verifyTaggedTxFn ??
      ((client: PublicClient, hash: Hex) =>
        verifyTaggedTx(client as never, hash));
    const suffix = getAttributionSuffix();

    const quoteTaker = quote.normalized.raw.taker;
    if (
      typeof quoteTaker === "string" &&
      quoteTaker.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error(
        `Quote taker ${quoteTaker} does not match the settling account ${account.address}. Refusing.`,
      );
    }
    const assertNotExpired = () => {
      if (quote.expiresAt && Date.now() >= Date.parse(quote.expiresAt)) {
        throw new Error(
          `Firm quote ${quote.rfqId} passed its accept cutoff (${quote.expiresAt}). ` +
            "Request a new quote instead of broadcasting.",
        );
      }
    };
    assertNotExpired();

    const broadcast = async (
      label: string,
      tx: { to: Address; data: Hex; value: bigint },
    ): Promise<Hex> => {
      // Simulate the exact tagged bytes the wallet client will send.
      await publicClient.call({
        account,
        to: tx.to,
        data: `${tx.data}${suffix.slice(2)}` as Hex,
        value: tx.value,
      });
      const hash = await walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`${label} transaction ${hash} reverted on chain.`);
      }
      const tag = await verifyFn(publicClient, hash);
      if (!tag.tagged) {
        throw new Error(
          `${label} transaction ${hash} landed WITHOUT the attribution tag. ` +
            "It cannot be credited; stopping here.",
        );
      }
      return hash;
    };

    const approvalHashes: Hex[] = [];
    const allowance = await publicClient.readContract({
      address: sellToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, quote.reactor],
    });
    if (allowance < quote.takerPaysRaw) {
      if (allowance > 0n) {
        // USDT-style tokens reject approve(nonzero -> nonzero). Reset first.
        approvalHashes.push(
          await broadcast("approval reset", {
            to: sellToken,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [quote.reactor, 0n],
            }),
            value: 0n,
          }),
        );
      }
      const approval = quote.transactions.approval;
      approvalHashes.push(
        await broadcast("approval", {
          to: approval?.to ?? sellToken,
          data:
            approval?.data ??
            encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [quote.reactor, quote.takerPaysRaw],
            }),
          value: approval ? BigInt(approval.value) : 0n,
        }),
      );
    }

    assertNotExpired();
    const swap = quote.transactions.swap;
    const swapHash = await broadcast("swap", {
      to: swap.to,
      data: swap.data,
      value: BigInt(swap.value),
    });

    let rfqStatus: string | null = null;
    try {
      await this.fetchFn(`${this.baseUrl}/rfq/${quote.rfqId}/submit`, {
        method: "POST",
        headers: this.claimHeaders(quote.claimToken),
        body: JSON.stringify({ txHash: swapHash }),
      });
      rfqStatus = await this.getRfqStatus(quote);
    } catch {
      rfqStatus = null;
    }
    return { rfqId: quote.rfqId, approvalHashes, swapHash, rfqStatus };
  }
}

/**
 * The TakerControl proof of control signature, byte for byte as the
 * Textile Authentication page specifies it: EIP-712, domain
 * "Textile Taker Control" version "1", a fresh 32 byte nonce, and
 * issuedAt in Unix milliseconds.
 */
export async function signTakerControl(
  account: Account,
  chainId: number = CELO_CHAIN_ID,
): Promise<{ nonce: Hex; issuedAt: number; signature: Hex }> {
  if (!account.signTypedData) {
    throw new Error("The taker account cannot sign typed data.");
  }
  const nonce = toHex(randomBytes(32)) as Hex;
  const issuedAt = Date.now();
  const signature = await account.signTypedData({
    domain: { name: "Textile Taker Control", version: "1", chainId },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl",
    message: {
      taker: account.address,
      chainId: BigInt(chainId),
      nonce,
      issuedAt: BigInt(issuedAt),
    },
  });
  return { nonce, issuedAt, signature };
}

/** Verify a TakerControl proof locally. Used by the tests; the API does this server side in production. */
export async function verifyTakerControl(input: {
  taker: Address;
  chainId: number;
  nonce: Hex;
  issuedAt: number;
  signature: Hex;
}): Promise<boolean> {
  return verifyTypedData({
    address: input.taker,
    domain: { name: "Textile Taker Control", version: "1", chainId: input.chainId },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl",
    message: {
      taker: input.taker,
      chainId: BigInt(input.chainId),
      nonce: input.nonce,
      issuedAt: BigInt(input.issuedAt),
    },
    signature: input.signature,
  });
}

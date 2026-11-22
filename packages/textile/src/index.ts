import { randomBytes } from "node:crypto";
import {
  formatUnits,
  parseUnits,
  toHex,
  verifyTypedData,
  type Account,
  type Address,
  type Hex,
} from "viem";
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
 * Deliberate boundary: this prep build QUOTES ONLY. It never submits an
 * RFQ for settlement and never broadcasts a conversion transaction.
 * Execution lands with the payout worker after the wallet is funded
 * (see STATUS.md in this package). `submitQuote` below exists only to
 * fail loudly if anything tries.
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
  if (raw.quote && typeof raw.quote === "object") return raw.quote;
  if (raw.data && typeof raw.data === "object") return raw.data;
  return raw;
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

export interface TextileClientOptions {
  baseUrl?: string;
  fetchFn?: FetchFn;
  /** Optional partner API key. Quotes work without one; a key only replaces the taker proof. */
  apiKey?: string;
}

export class TextileQuoteClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly apiKey?: string;

  constructor(options: TextileClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? TEXTILE_API_BASE;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as FetchFn);
    this.apiKey = options.apiKey;
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
   * Firm quote. POST /v2/rfq/request, following the docs pattern exactly:
   * send unsigned first, and only when the API answers 401 with reason
   * proof_of_control_required, sign the TakerControl challenge with the
   * taker wallet and retry once. A firm quote locks maker inventory for
   * the taker until it expires; it moves no funds by itself, and this
   * client never submits it for settlement.
   */
  async requestFirmQuote(
    input: QuoteRequest & { account: Account },
  ): Promise<NormalizedQuote> {
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
    const raw = (await res.json()) as RawTextileQuote;
    return normalizeQuote(raw, input);
  }

  /**
   * Execution is deliberately not implemented in this prep build.
   * Submitting a firm quote settles a real conversion on mainnet, which
   * is blocked until the agent wallet is funded and the payout worker
   * lands. See STATUS.md.
   */
  async submitQuote(): Promise<never> {
    throw new Error(
      "Textile execution is disabled in this prep build: quotes only, no conversion. " +
        "Settlement lands with the payout worker after wallet funding (see STATUS.md).",
    );
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

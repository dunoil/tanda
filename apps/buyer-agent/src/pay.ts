import {
  wrapFetchWithPayment,
  x402Client,
  decodePaymentResponseHeader,
} from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import {
  createPublicClient,
  getAddress,
  http,
  type Account,
  type Address,
} from "viem";
import { celo, celoSepolia } from "viem/chains";
import { ATTRIBUTION_CODE } from "@tanda/wallet";
import { USDT_ADDRESS, parseUSDT } from "@tanda/money";

/**
 * Buyer side of the x402 flow, per the Celo facilitator skill
 * (https://x402.celo.org/skill.md, buyer flow).
 *
 * Facts this module is built on:
 * - The buyer needs NO facilitator API key. The key is a seller side
 *   metering credential only. This is why the buyer flow can be built
 *   and rehearsed end to end before Duan creates the key.
 * - The buyer does need a funded wallet in the priced asset: mainnet
 *   USDT for the real desk, testnet USDC from the Circle faucet
 *   (faucet.circle.com, Celo Sepolia) for rehearsal. EIP-3009 assets
 *   settle from a signed authorization, so the buyer needs no native
 *   gas on the hosted facilitator.
 * - Use the v2 client: x402Client, register the exact EVM scheme with a
 *   chain reading signer ({ rpcUrl }), then wrapFetchWithPayment. Use
 *   setSpendControls, not the constructor: a config object passed to
 *   the constructor is silently ignored.
 * - Spend controls: USDT is in the client default asset table since
 *   @x402/evm 2.26.0 with a default cap of 1 dollar per payment. Tanda
 *   still opts the asset in explicitly with an atomic cap, which the
 *   skill calls the right habit, and lifts the USD cap deliberately.
 * - The BuilderCode client extension carries the project attribution
 *   code as a service code on every payment payload, matching the
 *   builder-code declaration the desk makes in its 402 responses.
 */

export type BuyerNetwork = "mainnet" | "testnet";

export const BUYER_NETWORK_IDS: Record<BuyerNetwork, `eip155:${number}`> = {
  mainnet: "eip155:42220",
  testnet: "eip155:11142220",
};

export const BUYER_RPC_URLS: Record<BuyerNetwork, string> = {
  mainnet: "https://forno.celo.org",
  testnet: "https://forno.celo-sepolia.celo-testnet.org",
};

export const SEPOLIA_USDC =
  "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as const;

export interface BuyerClientOptions {
  network: BuyerNetwork;
  /** Human string cap per payment in the priced asset, for example "2.00". Default "2.00". */
  maxPerPayment?: string;
  rpcUrl?: string;
}

export function buildBuyerClient(account: Account, options: BuyerClientOptions) {
  const network = BUYER_NETWORK_IDS[options.network];
  const asset = options.network === "mainnet" ? USDT_ADDRESS : SEPOLIA_USDC;
  const capAtomic = parseUSDT(options.maxPerPayment ?? "2.00").toString();
  const client = new x402Client();
  client.setSpendControls({
    allowedAssets: [
      {
        network,
        asset: getAddress(asset),
        maxAmountPerPayment: capAtomic,
      },
    ],
    maxAmountPerPayment: "$50",
  });
  // The scheme needs a signer that can also READ the chain (the skill:
  // a bare account signs no Permit2 permit, and composing the account
  // with a public client via toClientEvmSigner is the documented fix).
  const rpcUrl = options.rpcUrl ?? BUYER_RPC_URLS[options.network];
  const publicClient = createPublicClient({
    chain: options.network === "mainnet" ? celo : celoSepolia,
    transport: http(rpcUrl),
  });
  const signer = toClientEvmSigner(
    account as never,
    publicClient as never,
  );
  client.register("eip155:*", new ExactEvmScheme(signer));
  client.registerExtension(new BuilderCodeClientExtension(ATTRIBUTION_CODE));
  return client;
}

export interface PayResult {
  status: number;
  body: unknown;
  /** Decoded payment-response header when the server returned one: the settlement receipt. */
  paymentResponse: Record<string, unknown> | null;
}

type FetchLike = (
  input: string | Request,
  init?: RequestInit,
) => Promise<Response>;

/** One HTTP attempt's signing context, handed to a FreshHeadersProvider. */
export interface FreshHeaderRequest {
  method: string;
  url: string;
  body?: string;
}

/**
 * Produces freshly signed headers for ONE HTTP attempt. Called once per
 * attempt (the initial request, the paid retry, and any further retry),
 * never once per payment.
 *
 * Why this exists: the Self verifier's replay protection keys on the
 * pair (signature, signed message), and the signed message covers the
 * request timestamp (keccak256(timestamp + METHOD + url + bodyHash) in
 * the @selfxyz/agent-sdk signing scheme). The desk runs its Self gate
 * before the x402 middleware, so the first attempt already records that
 * pair; presenting the SAME signed headers on the paid retry is, to the
 * verifier, indistinguishable from a replay attack and is refused with
 * "Replay detected". Static headers therefore cannot survive a 402
 * round trip against a replay protected gate. Fresh headers per attempt
 * (new timestamp, new message, new signature) are the correct shape,
 * and they weaken nothing: every attempt is independently verified.
 */
export type FreshHeadersProvider = (
  req: FreshHeaderRequest,
) => Promise<Record<string, string>>;

export const SELF_TIMESTAMP_HEADER = "x-self-agent-timestamp";

/**
 * Wrap a fetch so every call through it first obtains freshly signed
 * headers for that exact attempt and sets them on the attempt's own
 * request (all other headers, including the payment headers the x402
 * wrapper adds on the retry, are preserved).
 *
 * The wrapper normalizes its input to a Request first: @x402/fetch
 * calls the base fetch with a Request object (not url plus init) on
 * every attempt, so reading method, URL and body off that Request is
 * the only shape that works for both the first request and the retry.
 * The fresh headers are set on a clone of the request, the same
 * pattern @x402/fetch itself uses for its payment headers.
 *
 * Millisecond guard: the signed message keys on a millisecond
 * timestamp, and ECDSA signing here is deterministic, so re-signing
 * inside the same millisecond would reproduce the identical signature
 * and trip the same replay check. If a provider returns a timestamp
 * that does not advance past the previous attempt's, wait for the clock
 * to move and ask again (bounded), so consecutive attempts always carry
 * distinct replay keys.
 */
export function withFreshHeaders(
  baseFetch: FetchLike,
  signHeaders: FreshHeadersProvider,
): FetchLike {
  let lastTimestamp: number | null = null;
  return async (input, init) => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    const rawBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : await request.clone().text();
    const signReq: FreshHeaderRequest = {
      method,
      url: request.url,
      body: rawBody === "" ? undefined : rawBody,
    };
    let fresh = await signHeaders(signReq);
    for (let tries = 0; tries < 100; tries++) {
      const ts = Number(fresh[SELF_TIMESTAMP_HEADER]);
      if (!Number.isFinite(ts) || lastTimestamp === null || ts > lastTimestamp) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      fresh = await signHeaders(signReq);
    }
    const ts = Number(fresh[SELF_TIMESTAMP_HEADER]);
    if (Number.isFinite(ts)) {
      lastTimestamp = ts;
    }
    const signed = request.clone();
    for (const [name, value] of Object.entries(fresh)) {
      signed.headers.set(name, value);
    }
    return baseFetch(signed);
  };
}

/**
 * Pay for one x402 protected resource: the wrapped fetch runs the whole
 * 402, sign, retry loop and returns the paid response.
 *
 * Static `headers` pass through untouched on both the first request and
 * the paid retry; use them only for headers that are safe to repeat.
 * Replay protected auth headers (the SelfAgent signed headers) must go
 * through `signHeaders` instead, so each attempt is signed fresh.
 */
export async function payForResource(
  url: string,
  input: {
    account: Account;
    network: BuyerNetwork;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signHeaders?: FreshHeadersProvider;
    maxPerPayment?: string;
    rpcUrl?: string;
    fetchImpl?: FetchLike;
  },
): Promise<PayResult> {
  const client = buildBuyerClient(input.account, {
    network: input.network,
    maxPerPayment: input.maxPerPayment,
    rpcUrl: input.rpcUrl,
  });
  const baseFetch: FetchLike =
    input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const signingFetch = input.signHeaders
    ? withFreshHeaders(baseFetch, input.signHeaders)
    : baseFetch;
  const payFetch = wrapFetchWithPayment(
    signingFetch as typeof fetch,
    client,
  );
  const res = await payFetch(url, {
    method: input.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.headers ?? {}),
    },
    body: input.body,
  });
  const paymentHeader = res.headers.get("payment-response");
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    paymentResponse: paymentHeader
      ? (decodePaymentResponseHeader(paymentHeader) as Record<string, unknown>)
      : null,
  };
}

export type { Address };

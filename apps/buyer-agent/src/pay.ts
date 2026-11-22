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

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Pay for one x402 protected resource: the wrapped fetch runs the whole
 * 402, sign, retry loop and returns the paid response. Extra headers
 * (for example the SelfAgent signed headers) pass through untouched on
 * both the first request and the paid retry.
 */
export async function payForResource(
  url: string,
  input: {
    account: Account;
    network: BuyerNetwork;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
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
  const payFetch = wrapFetchWithPayment(
    (input.fetchImpl ?? globalThis.fetch) as typeof fetch,
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

import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareBuilderCodeExtension } from "@x402/extensions/builder-code";
import { getAddress, type Address } from "viem";
import { ATTRIBUTION_CODE } from "@tanda/wallet";
import { USDT_ADDRESS, parseUSDT } from "@tanda/money";

/**
 * x402 seller wiring for the Tanda desk, built on the official Celo
 * facilitator skill (https://x402.celo.org/skill.md).
 *
 * Facts this module is built on, from the skill:
 * - Use the v2 scoped packages (@x402/hono, @x402/core, @x402/evm). The
 *   legacy packages have no Celo network entry.
 * - Mainnet facilitator: https://api.x402.celo.org. Testnet facilitator:
 *   https://api.x402.sepolia.celo.org. Networks are CAIP-2 eip155:42220
 *   and eip155:11142220. Scheme is "exact".
 * - Never price with a bare dollar string on Celo: it silently resolves
 *   to USDC. Always pass the explicit price object { amount, asset,
 *   extra: { name, version } } with amounts as raw unit strings. USDT on
 *   mainnet: address from @tanda/money, EIP-712 name "Tether USD",
 *   version "1", 6 decimals. Testnet has USDC only: 0x01C5...BC44E,
 *   name "USDC", version "2".
 * - payTo is the seller wallet that receives the money. It is not the
 *   facilitator and not the buyer.
 * - The API key goes only to the facilitator, as the X-API-Key header on
 *   verify, settle, and supported calls, through createAuthHeaders.
 *   Without it the facilitator rejects settlement with 401.
 * - The 402 response declares the builder-code extension with the Loops
 *   House issued code (BUILDERS.md): the Celo facilitator does not write
 *   ERC-8021 tags into settlement transactions yet, and the declared
 *   code is picked up automatically once facilitator tagging ships.
 *
 * THE BOUNDARY (see STATUS note in apps/server/STATUS.md): the API key
 * is created by a human, Duan, at https://x402.celo.org, connecting a
 * wallet and choosing Sign in with GitHub for mainnet free credits
 * (Skip gives testnet credits only, and GitHub cannot be added later).
 * The buyer side needs no key at all, and this server answers a correct
 * 402 with no key present, but no settlement can complete, on mainnet
 * OR testnet, until a key exists in X402_API_KEY. Testnet rehearsal of
 * the full loop therefore also waits on Duan: the dashboard step is his
 * wallet connect and signature, whichever credits he takes.
 */

export type X402Network = "mainnet" | "testnet";

export const FACILITATOR_URLS: Record<X402Network, string> = {
  mainnet: "https://api.x402.celo.org",
  testnet: "https://api.x402.sepolia.celo.org",
};

export const NETWORK_IDS: Record<X402Network, string> = {
  mainnet: "eip155:42220",
  testnet: "eip155:11142220",
};

export const SEPOLIA_USDC =
  "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as const;

export function resolveX402Network(
  env: NodeJS.ProcessEnv = process.env,
): X402Network {
  const raw = (env.X402_NETWORK ?? "mainnet").toLowerCase();
  if (raw === "mainnet" || raw === "testnet") return raw;
  throw new Error(`X402_NETWORK "${raw}" is not mainnet or testnet.`);
}

export function hasX402ApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = env.X402_API_KEY;
  if (!key) return false;
  // Two legitimate shapes: the raw facilitator key itself ("x402_..."),
  // and a Muse dynamic-credential surrogate ("hsurr:...") injected into
  // this process environment by the vault launcher. A surrogate is not
  // the key: Muse swaps it for the real credential on approved egress
  // to the registered facilitator hosts, so this process never holds the
  // raw key. Any other value is treated as no key.
  return key.startsWith("x402_") || key.startsWith("hsurr:");
}

/**
 * The one custom seller piece from the skill: an HTTPFacilitatorClient
 * that attaches the metering key to every facilitator call. The key is
 * read from the environment at call time and never logged.
 */
export function buildFacilitatorClient(network: X402Network) {
  return new HTTPFacilitatorClient({
    url: FACILITATOR_URLS[network],
    createAuthHeaders: async () => {
      const key = process.env.X402_API_KEY;
      const h: Record<string, string> = key ? { "X-API-Key": key } : {};
      return { verify: h, settle: h, supported: h };
    },
  });
}

export interface DeskRouteOptions {
  /** Seller wallet that receives payments. The desk payTo. */
  payTo: Address;
  /** Price per order as a human USDT string on mainnet, USDC on testnet. Default "0.10". */
  price: string;
  network: X402Network;
}

/**
 * The route config for POST /desk/order. The price object is always
 * explicit (asset address plus EIP-712 domain), never a bare dollar
 * string, and the builder-code extension declares the issued
 * attribution code on every 402 this route produces.
 */
export function buildDeskRoutes(options: DeskRouteOptions) {
  const isMainnet = options.network === "mainnet";
  const asset = isMainnet ? USDT_ADDRESS : SEPOLIA_USDC;
  const amount = parseUSDT(options.price).toString();
  return {
    "POST /desk/order": {
      accepts: [
        {
          scheme: "exact",
          network: NETWORK_IDS[options.network],
          payTo: getAddress(options.payTo),
          price: {
            amount,
            asset: getAddress(asset),
            extra: isMainnet
              ? { name: "Tether USD", version: "1" }
              : { name: "USDC", version: "2" },
          },
        },
      ],
      description:
        "Tanda desk order: a human backed agent pays in USDT over x402, the desk converts to IDRX over Textile FX and pays the freelancer.",
      extensions: {
        "builder-code": declareBuilderCodeExtension(ATTRIBUTION_CODE),
      },
    },
  };
}

/** The x402 resource server for the desk, with the exact EVM scheme registered. */
export function buildResourceServer(network: X402Network) {
  const server = new x402ResourceServer(buildFacilitatorClient(network));
  server.register("eip155:*", new ExactEvmScheme());
  return server;
}

/**
 * Whether settlements can complete in this process. The 402 challenge
 * works without a key; settlement does not. The server boot logs this
 * so the boundary is visible instead of discovered at demo time.
 */
export function settlementReadiness(env: NodeJS.ProcessEnv = process.env): {
  ready: boolean;
  reason: string;
} {
  if (hasX402ApiKey(env)) {
    return { ready: true, reason: "X402_API_KEY present" };
  }
  return {
    ready: false,
    reason:
      "X402_API_KEY is not set. The desk answers 402 challenges, but the facilitator will reject settlement with 401 until Duan creates the key at https://x402.celo.org with Sign in with GitHub.",
  };
}

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { getAddress } from "viem";
import { paymentMiddleware } from "@x402/hono";
import { ATTRIBUTION_CODE, assertAttributionCode } from "@tanda/wallet";
import { IDRX_ADDRESS, USDT_ADDRESS } from "@tanda/money";
import {
  TextileNoQuoteError,
  TextileQuoteClient,
  meetsFloorRate,
} from "@tanda/textile";
import {
  createVerifierForMode,
  requireSelfAgent,
  resolveSelfMode,
  type AgentVerifier,
  type VerifiedAgentContext,
} from "./self.js";
import {
  buildDeskRoutes,
  buildResourceServer,
  resolveX402Network,
  settlementReadiness,
  type X402Network,
} from "./x402.js";

// Fail the boot on any attribution code drift. Untagged or wrongly tagged
// transactions are never credited by Loops House, so a wrong code is a
// stop the world error, not a warning.
assertAttributionCode(process.env.ATTRIBUTION_CODE ?? ATTRIBUTION_CODE);
if (
  process.env.ATTRIBUTION_CODE &&
  process.env.ATTRIBUTION_CODE !== ATTRIBUTION_CODE
) {
  throw new Error("ATTRIBUTION_CODE env does not match the issued code.");
}

/** The desk payTo defaults to the single enrolled agent wallet. */
export const DEFAULT_PAY_TO =
  "0xed328f847eF33f35148513DCEFB10069FcE53725" as const;

/**
 * Resolve the desk payTo: an explicit option wins, then the
 * SELLER_PAY_TO env var (the pattern documented in .env.example),
 * then the enrolled agent wallet. Since 22 Nov 2026 the live desk
 * points SELLER_PAY_TO at the separate treasury wallet: the Celo
 * facilitator refuses settlements where payer and payTo are the same
 * address, and the agent wallet is the buyer (EVIDENCE.md section 9).
 * An invalid env value is a boot error, never a silent fallback.
 */
export function resolvePayTo(
  env: NodeJS.ProcessEnv = process.env,
): `0x${string}` {
  const raw = env.SELLER_PAY_TO;
  if (!raw) return DEFAULT_PAY_TO;
  return getAddress(raw);
}

export interface DeskAppOptions {
  /** Injected in tests. Defaults to the verifier for the configured Self mode. */
  verifier?: AgentVerifier;
  /** Injected in tests. Defaults to the live Textile quote client (preview only). */
  textileClient?: Pick<TextileQuoteClient, "previewQuote">;
  payTo?: `0x${string}`;
  /** Human USDT price string for one desk order. Default "0.10" (test order price from CONCEPT.md). */
  price?: string;
  network?: X402Network;
  /**
   * Mount the x402 payment middleware on POST /desk/order. Default true.
   * Tests for the Self gate turn it off so the gate is exercised without
   * a facilitator; the 402 shape has its own tests with it on.
   */
  x402Enabled?: boolean;
  /** Facilitator sync on middleware start. Default true: initialize() only reads the facilitator public /supported list, which needs no API key. The key gates settlement, not the 402 challenge. */
  syncFacilitatorOnStart?: boolean;
}

type DeskVariables = { agent: VerifiedAgentContext };

export function createApp(options: DeskAppOptions = {}) {
  const app = new Hono<{ Variables: DeskVariables }>();
  const network = options.network ?? resolveX402Network();
  const readiness = settlementReadiness();
  const textile =
    options.textileClient ?? new TextileQuoteClient();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "tanda-desk",
      chainId: 42220,
      attributionCode: ATTRIBUTION_CODE,
      assets: { USDT: USDT_ADDRESS, IDRX: IDRX_ADDRESS },
      x402: { network, settlementReady: readiness.ready },
      self: { mode: resolveSelfMode() },
    }),
  );

  app.get("/desk/services", (c) =>
    c.json({
      services: [],
      note: "Service board lands with the first freelancer listing.",
    }),
  );

  // Free quote route: a Textile RFQ preview for USDT to IDRX. Preview
  // quotes need no wallet proof and no key, and move no funds.
  app.post("/desk/quote", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      usdtAmount?: string;
      floorRate?: string;
    } | null;
    if (!body?.usdtAmount) {
      return c.json({ error: "usdtAmount is required" }, 400);
    }
    try {
      const quote = await textile.previewQuote({
        usdtAmount: body.usdtAmount,
      });
      return c.json({
        quote: {
          id: quote.id,
          usdtAmount: quote.usdtAmount,
          usdtRaw: quote.usdtRaw.toString(),
          idrxAmount: quote.idrxAmount,
          idrxRaw: quote.idrxRaw.toString(),
          effectiveRateIdrxPerUsdt: quote.effectiveRateIdrxPerUsdt,
          feeBps: quote.feeBps,
          expiresAt: quote.expiresAt,
        },
        ...(body.floorRate
          ? { meetsFloorRate: meetsFloorRate(quote, body.floorRate) }
          : {}),
      });
    } catch (err) {
      if (err instanceof TextileNoQuoteError) {
        return c.json({ error: "no_quote" }, 422);
      }
      return c.json(
        { error: "quote_failed", detail: err instanceof Error ? err.message : "unknown" },
        502,
      );
    }
  });

  // The paid order route. Order of gates is the product, per CONCEPT.md:
  // Self verification first (403 with a reason code on any failure), then
  // the x402 payment middleware (402 with the priced requirement and the
  // builder-code extension), then the handler.
  const verifier =
    options.verifier ??
    createVerifierForMode({ mode: resolveSelfMode() });
  app.use("/desk/order", requireSelfAgent({ verifier }));

  if (options.x402Enabled !== false) {
    const routes = buildDeskRoutes({
      payTo: options.payTo ?? resolvePayTo(),
      price: options.price ?? process.env.DESK_PRICE_USDT ?? "0.10",
      network,
    });
    const server = buildResourceServer(network);
    const sync = options.syncFacilitatorOnStart ?? true;
    app.use(
      "/desk/order",
      paymentMiddleware(
        routes as never,
        server,
        undefined,
        undefined,
        sync,
      ) as MiddlewareHandler,
    );
  }

  app.post("/desk/order", (c) => {
    const agent = c.get("agent");
    return c.json(
      {
        status: "order_created",
        agent: {
          address: agent.agentAddress,
          agentId: agent.agentId,
          nullifier: agent.nullifier,
          tier: agent.tier,
        },
        note: "Payout leg (Textile conversion and IDRX transfer) runs on job completion, after wallet funding. See STATUS.md.",
      },
      201,
    );
  });

  return app;
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const readiness = settlementReadiness();
  if (!readiness.ready) {
    console.warn(`x402 settlement not ready: ${readiness.reason}`);
  }
  serve({ fetch: createApp().fetch, port });
  console.log(`Tanda desk listening on http://localhost:${port}`);
}

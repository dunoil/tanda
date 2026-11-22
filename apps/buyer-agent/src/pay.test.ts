import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import { payForResource, SEPOLIA_USDC } from "./pay.js";

const PAY_TO = "0xed328f847eF33f35148513DCEFB10069FcE53725" as const;
const URL = "http://localhost/desk/order";

/**
 * A stub x402 resource server in the documented v2 wire shape: 402 with
 * a base64 payment-required header, then 200 once a payment-signature
 * header arrives. It settles nothing; it exists so the buyer client runs
 * its real 402, sign, retry loop offline, with a throwaway key and no
 * funds. The signing is real EIP-3009; only the facilitator is absent.
 */
function stubDesk(amount: string, captured: { payload?: unknown }) {
  const app = new Hono();
  app.post("/desk/order", (c) => {
    const payment = c.req.header("payment-signature");
    if (!payment) {
      const required = {
        x402Version: 2,
        error: "Payment required",
        resource: {
          url: URL,
          description: "Tanda desk order",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:11142220",
            amount,
            asset: SEPOLIA_USDC,
            payTo: PAY_TO,
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          },
        ],
        extensions: {},
      };
      return c.json(
        { error: "Payment required" },
        402,
        {
          "payment-required": Buffer.from(
            JSON.stringify(required),
          ).toString("base64"),
        },
      );
    }
    captured.payload = JSON.parse(
      Buffer.from(payment, "base64").toString("utf8"),
    );
    const receipt = { success: true, transaction: `0x${"ab".repeat(32)}` };
    return c.json({ status: "order_created" }, 201, {
      "payment-response": Buffer.from(JSON.stringify(receipt)).toString(
        "base64",
      ),
    });
  });
  return app;
}

function fetchFor(app: Hono) {
  return (async (url: string, init?: RequestInit) =>
    app.request(url, init)) as unknown as (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
}

describe("buyer payment flow against a stub desk (testnet shape)", () => {
  it("completes the 402, sign, retry loop and returns the settlement receipt", async () => {
    const account: Account = privateKeyToAccount(generatePrivateKey());
    const captured: { payload?: unknown } = {};
    const result = await payForResource(URL, {
      account,
      network: "testnet",
      body: JSON.stringify({ serviceId: "translation-check" }),
      fetchImpl: fetchFor(stubDesk("10000", captured)),
    });
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ status: "order_created" });
    expect(result.paymentResponse).toMatchObject({ success: true });

    const payload = captured.payload as {
      accepted?: { payTo: string; asset: string; amount: string };
      payload?: {
        authorization?: { from: string; to: string; value: string };
        signature?: string;
      };
    };
    expect(payload.accepted?.payTo).toBe(PAY_TO);
    const auth = payload.payload?.authorization;
    expect(auth?.from).toBe(account.address);
    expect(auth?.to).toBe(PAY_TO);
    expect(auth?.value).toBe("10000");
    expect(payload.payload?.signature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("refuses a price above the per payment cap before signing", async () => {
    const account: Account = privateKeyToAccount(generatePrivateKey());
    const captured: { payload?: unknown } = {};
    // 3.00 priced, cap 2.00: the client spend controls must reject it
    // client side, so no payment payload is ever produced.
    await expect(
      payForResource(URL, {
        account,
        network: "testnet",
        maxPerPayment: "2.00",
        body: "{}",
        fetchImpl: fetchFor(stubDesk("3000000", captured)),
      }),
    ).rejects.toThrow();
    expect(captured.payload).toBeUndefined();
  });
});

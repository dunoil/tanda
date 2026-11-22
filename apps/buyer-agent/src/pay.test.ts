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
  return (async (input: string | Request, init?: RequestInit) =>
    app.request(input, init)) as unknown as (
    input: string | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

interface SelfAttempt {
  signature: string | undefined;
  timestamp: string | undefined;
  hasPayment: boolean;
}

/** Stub desk that also records the Self headers of every attempt. */
function stubDeskRecordingSelf(amount: string, attempts: SelfAttempt[]) {
  const app = new Hono();
  app.post("/desk/order", (c) => {
    const payment = c.req.header("payment-signature");
    attempts.push({
      signature: c.req.header("x-self-agent-signature"),
      timestamp: c.req.header("x-self-agent-timestamp"),
      hasPayment: Boolean(payment),
    });
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
      return c.json({ error: "Payment required" }, 402, {
        "payment-required": Buffer.from(JSON.stringify(required)).toString(
          "base64",
        ),
      });
    }
    const receipt = { success: true, transaction: `0x${"ab".repeat(32)}` };
    return c.json({ status: "order_created" }, 201, {
      "payment-response": Buffer.from(JSON.stringify(receipt)).toString(
        "base64",
      ),
    });
  });
  return app;
}

/**
 * A Self signer in the SDK's shape: the signed message covers the
 * millisecond timestamp, so a fresh timestamp yields a fresh signature
 * and therefore a fresh verifier replay key (signature, message).
 */
function sdkShapedSigner(account: Account) {
  return async (req: { method: string; url: string; body?: string }) => {
    const timestamp = Date.now().toString();
    const signature = await account.signMessage!({
      message: `${timestamp}:${req.method}:${req.url}:${req.body ?? ""}`,
    });
    return {
      "x-self-agent-address": account.address,
      "x-self-agent-signature": signature,
      "x-self-agent-timestamp": timestamp,
    };
  };
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

  it("signs the Self headers fresh on every attempt, so the paid retry is not a replay", async () => {
    const account: Account = privateKeyToAccount(generatePrivateKey());
    const attempts: SelfAttempt[] = [];
    const result = await payForResource(URL, {
      account,
      network: "testnet",
      body: JSON.stringify({ serviceId: "translation-check" }),
      signHeaders: sdkShapedSigner(account),
      fetchImpl: fetchFor(stubDeskRecordingSelf("10000", attempts)),
    });
    expect(result.status).toBe(201);
    // Two attempts reached the desk: the 402 request and the paid retry.
    expect(attempts).toHaveLength(2);
    expect(attempts[0].hasPayment).toBe(false);
    expect(attempts[1].hasPayment).toBe(true);
    // The verifier replay key is (signature, signed message) and the
    // message covers the timestamp: both must differ across attempts,
    // or the desk's gate refuses the retry with "Replay detected".
    expect(attempts[0].signature).toBeTruthy();
    expect(attempts[1].signature).toBeTruthy();
    expect(attempts[1].signature).not.toBe(attempts[0].signature);
    expect(attempts[1].timestamp).not.toBe(attempts[0].timestamp);
    expect(Number(attempts[1].timestamp)).toBeGreaterThan(
      Number(attempts[0].timestamp),
    );
  });

  it("re-asks the signer when it returns a non-advancing timestamp", async () => {
    const account: Account = privateKeyToAccount(generatePrivateKey());
    const attempts: SelfAttempt[] = [];
    const base = Date.now();
    let calls = 0;
    // Calls 1 and 2 return the same timestamp (a same-millisecond
    // re-sign would reproduce the identical signature). The wrapper
    // must wait and ask again until the timestamp advances.
    const stubbornSigner = async () => {
      calls++;
      const ts = calls <= 2 ? base : base + calls;
      return {
        "x-self-agent-address": account.address,
        "x-self-agent-signature": `0x${ts.toString(16)}`,
        "x-self-agent-timestamp": String(ts),
      };
    };
    const result = await payForResource(URL, {
      account,
      network: "testnet",
      body: JSON.stringify({ serviceId: "translation-check" }),
      signHeaders: stubbornSigner,
      fetchImpl: fetchFor(stubDeskRecordingSelf("10000", attempts)),
    });
    expect(result.status).toBe(201);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(attempts).toHaveLength(2);
    expect(Number(attempts[1].timestamp)).toBeGreaterThan(
      Number(attempts[0].timestamp),
    );
    expect(attempts[1].signature).not.toBe(attempts[0].signature);
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

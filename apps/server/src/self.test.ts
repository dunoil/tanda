import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import {
  MockSelfVerifier,
  classifyPolicy,
  mockSignRequest,
  requireSelfAgent,
  resolveSelfMode,
  type DeskVerification,
  type MockAgentRecord,
} from "./self.js";

const URL = "http://localhost/desk/order";
const BODY = JSON.stringify({ serviceId: "translation-check" });

function freshAccount(): { account: Account; record: MockAgentRecord } {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    account,
    record: { agentId: 5n, nullifier: 99n, hasHumanProof: true, isProofFresh: true },
  };
}

function deskApp(verifier: MockSelfVerifier, allowTrial = false) {
  const app = new Hono();
  app.use("/desk/order", requireSelfAgent({ verifier, allowTrial }));
  app.post("/desk/order", (c) =>
    c.json({ ok: true, agent: c.get("agent" as never) }),
  );
  return app;
}

async function signedRequest(account: Account, body = BODY) {
  const headers = await mockSignRequest(account, {
    method: "POST",
    url: URL,
    body,
  });
  return new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("mode resolution", () => {
  it("defaults to mainnet, never to mock", () => {
    expect(resolveSelfMode({})).toBe("mainnet");
    expect(resolveSelfMode({ SELF_AGENT_MODE: "mock" })).toBe("mock");
    expect(resolveSelfMode({ SELF_AGENT_MODE: "testnet" })).toBe("testnet");
  });

  it("refuses mock mode in production", () => {
    expect(() =>
      resolveSelfMode({ SELF_AGENT_MODE: "mock", NODE_ENV: "production" }),
    ).toThrow(/refused in production/);
  });
});

describe("policy classification", () => {
  const base: DeskVerification = {
    valid: false,
    agentAddress: "0xabc",
    agentId: "0",
    nullifier: "0",
    hasHumanProof: false,
    isProofFresh: false,
  };
  it("valid means full tier", () => {
    expect(classifyPolicy({ ...base, valid: true }).tier).toBe("full");
  });
  it("registered but stale means trial tier", () => {
    const decision = classifyPolicy({
      ...base,
      agentId: "5",
      hasHumanProof: true,
      isProofFresh: false,
    });
    expect(decision).toEqual({ tier: "trial", reason: "proof_stale_trial_only" });
  });
  it("no proof means none tier", () => {
    expect(classifyPolicy({ ...base, error: "no_human_proof" }).tier).toBe("none");
  });
});

describe("requireSelfAgent middleware (mock mode)", () => {
  it("refuses a request with no Self headers: 403 with a reason code", async () => {
    const app = deskApp(new MockSelfVerifier({}));
    const res = await app.request(URL, { method: "POST", body: BODY });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; reason: string };
    expect(json.error).toBe("agent_not_verified");
    expect(json.reason).toBe("missing_self_agent_headers");
  });

  it("refuses an unverified agent (signed, but not in the registry): 403", async () => {
    const { account } = freshAccount();
    const app = deskApp(new MockSelfVerifier({}));
    const res = await app.request(await signedRequest(account));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toBe("agent_not_registered");
  });

  it("refuses a registered agent with no human proof: 403", async () => {
    const { account, record } = freshAccount();
    const app = deskApp(
      new MockSelfVerifier({
        [account.address]: { ...record, hasHumanProof: false },
      }),
    );
    const res = await app.request(await signedRequest(account));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toBe("no_human_proof");
  });

  it("refuses a tampered body: the signature no longer matches, 403", async () => {
    const { account, record } = freshAccount();
    const app = deskApp(new MockSelfVerifier({ [account.address]: record }));
    const req = await signedRequest(account);
    const tampered = new Request(URL, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify({ serviceId: "something-else" }),
    });
    const res = await app.request(tampered);
    expect(res.status).toBe(403);
  });

  it("serves a verified and fresh agent, with the nullifier on the context", async () => {
    const { account, record } = freshAccount();
    const app = deskApp(new MockSelfVerifier({ [account.address]: record }));
    const res = await app.request(await signedRequest(account));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      agent: { agentId: string; nullifier: string; tier: string };
    };
    expect(json.agent.agentId).toBe("5");
    expect(json.agent.nullifier).toBe("99");
    expect(json.agent.tier).toBe("full");
  });

  it("refuses a stale proof on a full tier route, but serves it on a trial route", async () => {
    const { account, record } = freshAccount();
    const stale = { ...record, isProofFresh: false };
    const verifier = new MockSelfVerifier({ [account.address]: stale });

    const fullRes = await deskApp(verifier).request(await signedRequest(account));
    expect(fullRes.status).toBe(403);
    const fullJson = (await fullRes.json()) as { reason: string; tier: string };
    expect(fullJson.reason).toBe("proof_stale_trial_only");
    expect(fullJson.tier).toBe("trial");

    const trialRes = await deskApp(verifier, true).request(
      await signedRequest(account),
    );
    expect(trialRes.status).toBe(200);
  });
});

import type { Context, MiddlewareHandler } from "hono";
import {
  recoverMessageAddress,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { SelfAgentVerifier } from "@selfxyz/agent-sdk";

/**
 * Self Agent ID gate for the Tanda desk.
 *
 * Source: Self Agent ID docs (overview and quickstart at docs.self.xyz).
 * An agent is verified when `hasHumanProof && isProofFresh` in the Self
 * registry. The agent signs each request with its key; the service checks
 * the signature and the registry. Registry addresses:
 * - Celo mainnet (42220): 0xaC3DF9ABf80d0F5c020C06B04Cced27763355944, real documents only.
 * - Celo Sepolia (11142220): 0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379, mock passports only.
 * A real document fails on testnet and a mock fails on mainnet, so the
 * network mode is an explicit configuration, never a guess.
 *
 * Modes, selected with SELF_AGENT_MODE:
 * - "mainnet": the real SelfAgentVerifier against the mainnet registry.
 *   This is the default when the variable is unset, so a production boot
 *   can never silently run in mock mode.
 * - "testnet": the real SelfAgentVerifier against Celo Sepolia, for the
 *   mock passport dress rehearsal.
 * - "mock": a fully local verifier for development and tests. It checks a
 *   real ECDSA signature the same way the signing scheme does (recover
 *   the signer, then look the agent up), but the registry is an in
 *   memory map injected by the caller. Mock mode refuses to boot when
 *   NODE_ENV is "production".
 *
 * Policy tiers, from CONCEPT.md: verified and fresh gets full limits,
 * keyed to the human nullifier (not the agent key). Proof present but
 * stale gets a reduced trial tier: read and quote routes only, never the
 * payout route. No proof gets refused with HTTP 403 and a reason code.
 */

export const SELF_REGISTRY_MAINNET =
  "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944" as const;
export const SELF_REGISTRY_TESTNET =
  "0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379" as const;

export type SelfMode = "mainnet" | "testnet" | "mock";

export function resolveSelfMode(env: NodeJS.ProcessEnv = process.env): SelfMode {
  const raw = (env.SELF_AGENT_MODE ?? "mainnet").toLowerCase();
  if (raw === "mainnet" || raw === "testnet" || raw === "mock") {
    if (raw === "mock" && env.NODE_ENV === "production") {
      throw new Error(
        "SELF_AGENT_MODE=mock is refused in production. Mock verification is a local test mode only.",
      );
    }
    return raw;
  }
  throw new Error(
    `SELF_AGENT_MODE "${raw}" is not one of mainnet, testnet, mock.`,
  );
}

/** The normalized verification shape the desk policy works on, whichever verifier produced it. */
export interface DeskVerification {
  valid: boolean;
  agentAddress: string;
  /** Agent id in the registry, as a decimal string. "0" when unregistered. */
  agentId: string;
  /** Human nullifier as a decimal string, "0" when unknown. Caps are keyed to this. */
  nullifier: string;
  hasHumanProof: boolean;
  isProofFresh: boolean;
  error?: string;
  daysUntilExpiry?: number;
}

export interface AgentVerifier {
  verify(input: {
    signature: string;
    timestamp: string;
    method: string;
    url: string;
    body: string;
  }): Promise<DeskVerification>;
}

/** Adapter over the official SDK verifier (mainnet and testnet modes). */
export function createSdkVerifier(input: {
  network: "mainnet" | "testnet";
  sybilLimit?: number;
  rpcUrl?: string;
}): AgentVerifier {
  const verifier = SelfAgentVerifier.create()
    .network(input.network)
    .sybilLimit(input.sybilLimit ?? 1)
    .build();
  return {
    async verify(req) {
      const result = await verifier.verify(req);
      const stale =
        result.daysUntilExpiry !== undefined && result.daysUntilExpiry < 0;
      return {
        valid: result.valid,
        agentAddress: result.agentAddress,
        agentId: result.agentId.toString(),
        nullifier: result.nullifier.toString(),
        hasHumanProof: result.agentId !== 0n,
        isProofFresh: result.valid ? true : !stale,
        error: result.error,
        daysUntilExpiry: result.daysUntilExpiry,
      };
    },
  };
}

export interface MockAgentRecord {
  agentId: bigint;
  nullifier: bigint;
  hasHumanProof: boolean;
  isProofFresh: boolean;
}

/**
 * Local mock verifier for tests and offline development. Signature
 * scheme, deliberately simple and test only: the agent signs the string
 * `${timestamp}:${method}:${url}:${body}` with personal_sign style
 * signMessage, and the mock recovers the signer and looks it up in the
 * injected registry map. This exercises the real refusal logic (missing
 * headers, bad signature, unknown agent, stale proof) without a chain,
 * a phone, or a document scan. It is NOT the Self signing scheme and is
 * never used outside mock mode.
 */
export class MockSelfVerifier implements AgentVerifier {
  private readonly registry: Map<string, MockAgentRecord>;
  private readonly maxAgeMs: number;

  constructor(
    registry: Map<string, MockAgentRecord> | Record<string, MockAgentRecord>,
    options: { maxAgeMs?: number } = {},
  ) {
    this.registry =
      registry instanceof Map
        ? registry
        : new Map(
            Object.entries(registry).map(([k, v]) => [k.toLowerCase(), v]),
          );
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  }

  async verify(input: {
    signature: string;
    timestamp: string;
    method: string;
    url: string;
    body: string;
  }): Promise<DeskVerification> {
    const fail = (error: string): DeskVerification => ({
      valid: false,
      agentAddress: "",
      agentId: "0",
      nullifier: "0",
      hasHumanProof: false,
      isProofFresh: false,
      error,
    });
    const ts = Number(input.timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.maxAgeMs) {
      return fail("stale_timestamp");
    }
    let address: Address;
    try {
      address = await recoverMessageAddress({
        message: mockSigningMessage(input),
        signature: input.signature as Hex,
      });
    } catch {
      return fail("bad_signature");
    }
    const record = this.registry.get(address.toLowerCase());
    if (!record) {
      return {
        ...fail("agent_not_registered"),
        agentAddress: address,
      };
    }
    const valid = record.hasHumanProof && record.isProofFresh;
    return {
      valid,
      agentAddress: address,
      agentId: record.agentId.toString(),
      nullifier: record.nullifier.toString(),
      hasHumanProof: record.hasHumanProof,
      isProofFresh: record.isProofFresh,
      error: valid
        ? undefined
        : record.hasHumanProof
          ? "proof_not_fresh"
          : "no_human_proof",
      daysUntilExpiry: record.isProofFresh ? 30 : -1,
    };
  }
}

/** The mock signing message. Exported so tests and rehearsal scripts sign the identical string. */
export function mockSigningMessage(input: {
  timestamp: string;
  method: string;
  url: string;
  body: string;
}): string {
  return `${input.timestamp}:${input.method.toUpperCase()}:${input.url}:${input.body}`;
}

/** Sign a request the mock way. Test and rehearsal use only. */
export async function mockSignRequest(
  account: Account,
  input: { method: string; url: string; body: string },
): Promise<Record<string, string>> {
  if (!account.signMessage) {
    throw new Error("Account cannot sign messages.");
  }
  const timestamp = Date.now().toString();
  const signature = await account.signMessage({
    message: mockSigningMessage({ timestamp, ...input }),
  });
  return {
    "x-self-agent-address": account.address,
    "x-self-agent-signature": signature,
    "x-self-agent-timestamp": timestamp,
  };
}

export type PolicyTier = "full" | "trial" | "none";

export interface PolicyDecision {
  tier: PolicyTier;
  /** Machine readable reason, surfaced in the 403 body and on receipts. */
  reason: string;
}

/**
 * The payout policy, as a pure function so every branch is unit tested:
 * - valid (human proof present and fresh): full.
 * - registered agent whose proof exists but is stale: trial.
 * - everything else: none, refused.
 */
export function classifyPolicy(result: DeskVerification): PolicyDecision {
  if (result.valid) {
    return { tier: "full", reason: "verified_fresh" };
  }
  const stale =
    result.hasHumanProof &&
    !result.isProofFresh &&
    result.agentId !== "0";
  if (stale) {
    return { tier: "trial", reason: "proof_stale_trial_only" };
  }
  return { tier: "none", reason: result.error ?? "no_human_proof" };
}

export interface VerifiedAgentContext extends DeskVerification {
  tier: PolicyTier;
}

/**
 * Hono middleware: verify the SelfAgent signed headers before the
 * handler runs. Options:
 * - allowTrial: serve trial tier agents (quote and read routes). The
 *   payout route leaves this false, so a stale proof is refused there.
 * On any refusal the response is HTTP 403 with a JSON body of the shape
 * { error: "agent_not_verified", reason, tier }. On a pass, the verified
 * agent and its tier are available as c.get("agent").
 */
export function requireSelfAgent(options: {
  verifier: AgentVerifier;
  allowTrial?: boolean;
}): MiddlewareHandler {
  return async (c: Context, next) => {
    const signature = c.req.header("x-self-agent-signature");
    const timestamp = c.req.header("x-self-agent-timestamp");
    if (!signature || !timestamp) {
      return c.json(
        {
          error: "agent_not_verified",
          reason: "missing_self_agent_headers",
          tier: "none",
        },
        403,
      );
    }
    const body = await c.req.text();
    const result = await options.verifier.verify({
      signature,
      timestamp,
      method: c.req.method,
      url: c.req.url,
      body,
    });
    const decision = classifyPolicy(result);
    if (decision.tier === "none") {
      return c.json(
        { error: "agent_not_verified", reason: decision.reason, tier: "none" },
        403,
      );
    }
    if (decision.tier === "trial" && !options.allowTrial) {
      return c.json(
        {
          error: "agent_not_verified",
          reason: decision.reason,
          tier: "trial",
        },
        403,
      );
    }
    c.set("agent", { ...result, tier: decision.tier } satisfies VerifiedAgentContext);
    await next();
  };
}

/** Build the verifier for the configured mode. Mock mode needs an injected registry. */
export function createVerifierForMode(input: {
  mode: SelfMode;
  sybilLimit?: number;
  mockRegistry?: Map<string, MockAgentRecord> | Record<string, MockAgentRecord>;
}): AgentVerifier {
  if (input.mode === "mock") {
    if (!input.mockRegistry) {
      throw new Error(
        "Mock mode needs an injected mock registry. There is no default mock registry, by design.",
      );
    }
    return new MockSelfVerifier(input.mockRegistry);
  }
  return createSdkVerifier({
    network: input.mode,
    sybilLimit: input.sybilLimit,
  });
}

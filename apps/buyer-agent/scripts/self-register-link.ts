/**
 * Self Agent ID registration link generator for the Tanda agent wallet.
 *
 * Why this flow (researched from the official Self Agent ID docs,
 * docs.self.xyz/docs/agent-id, on 22 Nov 2026):
 *
 * - The hosted API flow (`requestRegistration`) makes the Self API
 *   generate a BRAND NEW agent key for the `linked` and `wallet-free`
 *   modes. That new key would not be our agent wallet, so it is the
 *   wrong flow for Tanda: the desk gate verifies the registry entry
 *   for the exact key that signs requests, and our buyer agent signs
 *   with the agent wallet key from tanda/.env.
 * - The self-hosted QR flow from the same docs ("Render the QR code
 *   without the API") registers an EXISTING key. For a wallet-free
 *   registration the agent key proves control of itself by signing a
 *   registration challenge (humanIdentifier = the agent address
 *   itself, per the SDK CLI source), and the ASCII userData in "W"
 *   format carries: agent address, optional guardian, and that
 *   signature. The human scans the request with the Self app, the
 *   phone builds the ZK proof, Hub V2 verifies it onchain, and the
 *   Self registry mints a soulbound NFT to the agent's own address,
 *   binding the agent key to the human's nullifier.
 *
 * This script sends NO transaction and spends NO gas. It only:
 * 1. Reads the agent's current registry state (eth_call reads).
 * 2. Signs the registration challenge locally with the agent key.
 * 3. Builds the Self app request and prints its universal deep link.
 *
 * The link stays valid until the agent's registry nonce changes
 * (registration itself bumps it). Anyone who scans the link with
 * their own document would bind THEIR identity to our agent, so
 * treat the link as private to Duan even though it contains no key
 * material.
 *
 * Usage:
 *   npm run self:link -w @tanda/buyer-agent            print state + fresh deep link (JSON)
 *   npm run self:link -w @tanda/buyer-agent -- --check print state only (post-scan confirmation)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  SelfAgent,
  buildWalletFreeRegisterUserDataAscii,
  signRegistrationChallenge,
  typedRegistry,
} from "@selfxyz/agent-sdk";
import { SelfAppBuilder } from "@selfxyz/qrcode";
import { getUniversalLink } from "@selfxyz/common";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const SELF_REGISTRY_MAINNET =
  "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944" as const;
const CELO_CHAIN_ID = 42220;

function loadEnv(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../../.env");
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function readState(rpcUrl: string, privateKey: Hex) {
  const agent = new SelfAgent({ privateKey, network: "mainnet", rpcUrl });
  const info = await agent.getInfo();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const registry = typedRegistry(SELF_REGISTRY_MAINNET, provider);
  const nonce = await registry.agentNonces(agent.address);
  return { agent, info, nonce };
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const env = loadEnv();
  const privateKey = env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!privateKey) {
    console.error("AGENT_PRIVATE_KEY is not set in tanda/.env.");
    process.exit(1);
  }
  const rpcUrl = env.CELO_RPC_URL || "https://forno.celo.org";
  const account = privateKeyToAccount(privateKey);
  if (
    env.AGENT_ADDRESS &&
    env.AGENT_ADDRESS.toLowerCase() !== account.address.toLowerCase()
  ) {
    console.error("AGENT_ADDRESS in .env does not match AGENT_PRIVATE_KEY.");
    process.exit(1);
  }

  const { info, nonce } = await readState(rpcUrl, privateKey);
  const state = {
    network: "mainnet",
    chainId: CELO_CHAIN_ID,
    registry: SELF_REGISTRY_MAINNET,
    agentAddress: account.address,
    agentNonce: nonce.toString(),
    selfAgentId: info.agentId.toString(),
    hasHumanProof: info.hasHumanProof,
    isProofFresh: info.isProofFresh,
    isVerified: info.isVerified,
    proofExpiresAt:
      info.proofExpiresAt === 0n
        ? null
        : new Date(Number(info.proofExpiresAt) * 1000).toISOString(),
    daysUntilExpiry: info.daysUntilExpiry,
  };

  if (checkOnly) {
    console.log(JSON.stringify({ mode: "check", state }, null, 2));
    return;
  }
  if (info.agentId !== 0n) {
    console.log(
      JSON.stringify(
        { mode: "link", note: "Agent already registered; no new link built.", state },
        null,
        2,
      ),
    );
    return;
  }

  // Wallet-free registration of our EXISTING key: the challenge is
  // signed by the agent key with humanIdentifier = the agent address
  // (this is exactly what the SDK CLI does for wallet-free mode).
  const signed = await signRegistrationChallenge(privateKey, {
    humanIdentifier: account.address,
    chainId: CELO_CHAIN_ID,
    registryAddress: SELF_REGISTRY_MAINNET,
    nonce: Number(nonce),
  });
  const disclosures = { minimumAge: 0, ofac: false } as const;
  const userDefinedData = buildWalletFreeRegisterUserDataAscii({
    agentAddress: account.address,
    signature: signed,
    disclosures,
  });
  const selfApp = new SelfAppBuilder({
    version: 2,
    appName: "Tanda Payout Desk",
    scope: "self-agent-id",
    endpoint: SELF_REGISTRY_MAINNET,
    endpointType: "celo",
    userId: account.address,
    userIdType: "hex",
    userDefinedData,
    disclosures: {},
  }).build();

  console.log(
    JSON.stringify(
      {
        mode: "link",
        generatedAt: new Date().toISOString(),
        state,
        sessionId: selfApp.sessionId,
        deepLink: getUniversalLink(selfApp),
        userDefinedData,
        validity:
          "No server session and no clock expiry. Valid until the agent nonce changes (a completed registration bumps it). Regenerate any time with: npm run self:link -w @tanda/buyer-agent",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

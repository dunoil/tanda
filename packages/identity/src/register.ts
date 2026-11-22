import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  buildRegistrationFile,
  formatDryRun,
  buildRegisterDryRun,
  registerAgent,
  IDENTITY_REGISTRY_MAINNET,
} from "./index.js";

/**
 * ERC-8004 registration script for the Tanda agent wallet.
 *
 * Usage:
 *   tsx src/register.ts <agentURI> [--live]
 *
 * Default mode is a dry run: it loads the agent key from AGENT_PRIVATE_KEY
 * (tanda/.env), builds the exact register(agentURI) transaction through
 * the tagged wallet factory path, and prints it. Nothing is sent, and the
 * key is never printed.
 *
 * --live sends the transaction. That is blocked until the agent wallet
 * 0xed328f847eF33f35148513DCEFB10069FcE53725 is funded: the send needs
 * about 0.05 CELO of gas (budget in BUILD-PLAN.md). See STATUS.md.
 *
 * The registration file to publish BEFORE registering (docs step 1) is
 * printed with:
 *   tsx src/register.ts --print-registration-file <hosted file URL is not needed yet>
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--print-registration-file") {
    const file = buildRegistrationFile({
      name: "Tanda Payout Desk Agent",
      description:
        "Buyer agent for the Tanda payout desk: pays Indonesian freelancers in USDT over x402, gated by a Self Agent ID human proof, settled to IDRX over Textile FX.",
      services: [
        { name: "web", endpoint: "https://dunoil.github.io/tanda/" },
        { name: "A2A", endpoint: "https://tanda-desk.onrender.com/desk/order" },
      ],
      x402Support: true,
      active: true,
    });
    console.log(JSON.stringify(file, null, 2));
    return;
  }

  const agentURI = args.find((a) => !a.startsWith("--"));
  if (!agentURI) {
    console.error(
      "Usage: tsx src/register.ts <agentURI> [--live] | --print-registration-file",
    );
    process.exit(1);
  }
  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    console.error("AGENT_PRIVATE_KEY is not set. Fill tanda/.env first.");
    process.exit(1);
  }
  const account = privateKeyToAccount(key);
  const live = args.includes("--live");

  if (!live) {
    const tx = buildRegisterDryRun({
      from: account.address,
      agentURI,
      registry: IDENTITY_REGISTRY_MAINNET,
    });
    console.log(formatDryRun(tx));
    return;
  }

  const result = await registerAgent({
    account,
    agentURI,
    dryRun: false,
  });
  if ("mode" in result) {
    console.log(formatDryRun(result));
    return;
  }
  console.log(`Registered. tx: ${result.txHash}`);
  console.log(`Agent id (from the Registered event): ${result.agentId}`);
  console.log(
    "Next, per the docs flow: update the hosted registration file with this id in registrations, and call setAgentURI if the file URI changed.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

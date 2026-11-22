import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { SelfAgent } from "@selfxyz/agent-sdk";
import {
  ATTRIBUTION_CODE,
  assertAttributionCode,
  createTaggedWalletClient,
} from "@tanda/wallet";
import { formatUSDT, parseUSDT } from "@tanda/money";
import { payForResource, type BuyerNetwork } from "./pay.js";

/**
 * Tanda buyer agent CLI.
 *
 * The demo and traction client other agent operators can copy. It will:
 * discover the desk through its ERC-8004 registration file, sign requests
 * with its SelfAgent key, pay through @x402/fetch, and confirm deliveries.
 *
 * Any direct transaction this agent ever sends goes through
 * createTaggedWalletClient, the single factory in @tanda/wallet, so it
 * carries the Loops House attribution tag. x402 payments themselves are
 * settled by the facilitator and are gasless for the buyer.
 */
function loadAccount() {
  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    console.error("AGENT_PRIVATE_KEY is not set. Copy .env.example to .env first.");
    process.exit(1);
  }
  return privateKeyToAccount(key);
}

async function main(): Promise<void> {
  assertAttributionCode();
  const command = process.argv[2] ?? "help";

  if (command === "whoami") {
    const account = loadAccount();
    createTaggedWalletClient({ account });
    console.log(`Buyer agent address: ${account.address}`);
    console.log(`Attribution code: ${ATTRIBUTION_CODE}`);
    return;
  }

  if (command === "price") {
    const amount = process.argv[3] ?? "1";
    console.log(`${amount} USDT is ${parseUSDT(amount)} raw units (6 decimals).`);
    console.log(`Round trip check: ${formatUSDT(parseUSDT(amount))} USDT.`);
    return;
  }

  if (command === "pay") {
    // npm run agent -- pay <desk order URL> [network] [maxPerPayment]
    // The buyer needs no facilitator API key (that is a seller side
    // credential). It does need a funded wallet in the priced asset:
    // testnet USDC from the Circle faucet for rehearsal, mainnet USDT
    // for the real desk. Until the wallet is funded, a real desk will
    // refuse at settlement; the flow itself is exercised offline by the
    // unit tests against a stub desk.
    const url = process.argv[3];
    if (!url) {
      console.error("Usage: npm run agent -- pay <url> [mainnet|testnet] [maxPerPayment]");
      process.exit(1);
    }
    const network = (process.argv[4] ?? "testnet") as BuyerNetwork;
    const account = loadAccount();
    // Sign the SelfAgent headers FRESH on every HTTP attempt. The desk's
    // Self gate runs before its payment middleware and the verifier's
    // replay protection keys on (signature, signed message), where the
    // signed message covers the timestamp: one static signature reused
    // on the paid retry is refused as "Replay detected" (proven on
    // mainnet, EVIDENCE.md section 10). payForResource calls this
    // provider once per attempt, so the 402 request and the paid retry
    // each carry their own signature.
    const selfAgent = new SelfAgent({
      privateKey: process.env.AGENT_PRIVATE_KEY as Hex,
      network,
    });
    const result = await payForResource(url, {
      account,
      network,
      maxPerPayment: process.argv[5] ?? "2.00",
      body: JSON.stringify({ serviceId: "translation-check" }),
      signHeaders: (req) =>
        selfAgent.signRequest(req.method, req.url, req.body),
    });
    console.log(`Status: ${result.status}`);
    console.log(`Body: ${JSON.stringify(result.body)}`);
    if (result.paymentResponse) {
      console.log(`Settlement: ${JSON.stringify(result.paymentResponse)}`);
    }
    return;
  }

  console.log("Usage:");
  console.log("  npm run agent -- whoami   Show the buyer agent address and tag");
  console.log("  npm run agent -- price 1  Check USDT amount parsing (6 decimals)");
  console.log("  npm run agent -- pay <url> [mainnet|testnet] [cap]  Pay an x402 desk order");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

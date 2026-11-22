import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  executePayout,
  formatPayoutDryRun,
  PayoutPreflightError,
  formatPreflight,
} from "./index.js";

/**
 * IDRX payout script for the Tanda treasury wallet.
 *
 * Usage:
 *   tsx src/payout.ts <recipientAddress> <amountIDRX> [--live] [--from-block <n>]
 *
 * Default mode is a dry run: it loads the treasury key from
 * TREASURY_PRIVATE_KEY (tanda/.env), runs the full pre-flight
 * (including the no prior inbound from us scan), simulates the exact
 * tagged transfer, and prints the would-be transaction. Nothing is
 * sent, and the key is never printed.
 *
 * --live attempts a real send, which additionally requires the
 * PAYOUT_EXECUTION_ENABLED=true opt-in in the environment. Even then,
 * Duan's notify-first rule for this project applies: the exact payout
 * (recipient, amount, this dry run output) is announced to him and
 * approved before --live is ever run.
 *
 * --from-block <n> shortens the pre-flight history scan. Only pass a
 * block that neither Tanda wallet could have acted before (for
 * example the block the agent wallet was funded at); the default
 * scans the full history.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const [recipient, amountIDRX] = positional;
  if (!recipient || !amountIDRX || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    console.error(
      "Usage: tsx src/payout.ts <recipientAddress> <amountIDRX> [--live] [--from-block <n>]",
    );
    process.exit(1);
  }
  const key = process.env.TREASURY_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    console.error("TREASURY_PRIVATE_KEY is not set. Fill tanda/.env first.");
    process.exit(1);
  }
  const account = privateKeyToAccount(key);
  const live = args.includes("--live");
  const fromBlockIdx = args.indexOf("--from-block");
  const scanFromBlock =
    fromBlockIdx >= 0 ? BigInt(args[fromBlockIdx + 1]) : undefined;

  try {
    const result = await executePayout({
      account,
      recipient: recipient as Address,
      amountIDRX,
      dryRun: !live,
      scanFromBlock,
    });
    if (result.mode === "dry-run") {
      console.log(formatPayoutDryRun(result));
      return;
    }
    console.log(`Payout sent. tx: ${result.txHash}`);
    console.log(
      `CeloScan: https://celoscan.io/tx/${result.txHash}`,
    );
    console.log(
      "Next: fill the order evidence pack with this hash and verify the tag line reads yes.",
    );
  } catch (err) {
    if (err instanceof PayoutPreflightError) {
      console.error(formatPreflight(err.preflight));
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

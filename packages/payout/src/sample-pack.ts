import type { Address, Hash } from "viem";
import {
  defaultOrdersDir,
  writeEvidencePack,
  type OrderEvidenceInput,
} from "./evidence.js";
import { TREASURY_ADDRESS } from "./index.js";

/**
 * Generate the SAMPLE evidence pack.
 *
 * Usage:
 *   tsx src/sample-pack.ts [ordersDir]
 *
 * The sample is populated ONLY with facts that already happened on
 * mainnet (EVIDENCE.md sections 11 and 14): the internal micro order
 * settlement (0.10 USDT, agent wallet to treasury, Self gate tier
 * full) and the treasury Textile conversion (1.00 USDT to
 * 18,339.92 IDRX). There is no freelancer in this sample and none is
 * invented: every freelancer, work, invoice, payout, and confirmation
 * field is a TODO placeholder, and the pack carries the SAMPLE banner
 * from the writer. Its only job is to prove the writer end to end with
 * links that resolve, before the first genuine order needs it.
 */
const SAMPLE_INPUT: OrderEvidenceInput = {
  orderId: "SAMPLE-001",
  orderType: "first",
  orderDateTimeWita:
    "22 Nov 2026, about 12:31 WITA (micro order settlement); conversion about 12:51 WITA",
  buyerAgent: {
    name: "Tanda Payout Desk Agent",
    erc8004AgentId: "10094",
  },
  buyerOperator: "Duan",
  selfCheckResult:
    "verified and fresh (Self agent ID 207), policy decision: full tier, no refusal or cap applied (EVIDENCE.md section 11)",
  freelancer: {
    name: "TODO: no freelancer exists for this sample; none is invented",
    recruitedVia:
      "TODO: not applicable to the sample; recruitment channels are recorded per real order",
  },
  service: {
    title: "translation-check (desk micro order service)",
    description:
      "Internal proof order of the desk's translation-check service at the desk price of 0.10 USDT. In this sample the buyer agent and the desk are both Tanda's own wallets; no freelancer service was ordered or delivered.",
    priceUSDT: "0.10",
    deliveryWindow: "TODO: not applicable to the sample",
    revisionTerms: "TODO: not applicable to the sample",
  },
  freelancerWallet: {
    // No address on purpose: the sample has no freelancer, and the
    // writer renders a TODO instead of borrowing a real address.
  },
  work: {},
  invoice: {},
  chain: {
    x402: {
      txHash:
        "0xbb47c7b8500e8e891892a9da905c02618ae324c38fdbadd7ca659e8bdf6a6e05" as Hash,
      amountAndAsset: "0.10 USDT",
      payTo: TREASURY_ADDRESS as Address,
      builderCodeNote:
        "celo_f58da6359b7f declared in the builder-code extension of the 402 response (EVIDENCE.md section 11)",
    },
    conversion: {
      rfqId: "rfq_mMRKpH2yT0UxRWoC",
      rateAndFee:
        "18,339.92 IDRX per USDT effective rate; feeAmount 199 raw as returned by the API (EVIDENCE.md section 14)",
      txHash:
        "0xe160e12791e89091d52ecac641c39caadbfae12b58c841195e106f08981a67cb" as Hash,
      tagVerified: true,
      amountInUSDT: "1.00",
      amountOutIDRX: "18,339.92",
    },
    // payout: deliberately absent. No payout has happened; the writer
    // renders TODO placeholders for it.
  },
  completedOn: "22 Nov 2026",
  completedBy: "Glint (sample generation, payout package preparation run)",
  sample: true,
};

async function main(): Promise<void> {
  const ordersDir = process.argv[2] ?? defaultOrdersDir();
  const { file } = await writeEvidencePack(SAMPLE_INPUT, ordersDir);
  console.log(`Sample evidence pack written: ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

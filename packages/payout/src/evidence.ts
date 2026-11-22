import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hash } from "viem";
import { celoscanAddressUrl, celoscanTxUrl } from "./index.js";

/**
 * Per-order evidence pack writer.
 *
 * Emits a completed instance of the template in EVIDENCE-PACK.md (in
 * the project folder) for one freelancer order: same sections, same
 * order, same verification guide, with the fields filled from the
 * order metadata and every hash rendered with its CeloScan link.
 *
 * Honesty rules, enforced by construction:
 * - A field the caller does not supply renders as a TODO placeholder,
 *   never as an empty line and never as an invented value. Empty
 *   fields read as missing evidence; TODO fields read as work still
 *   owed, which is the truth while an order is in flight.
 * - The writer invents nothing: no names, no hashes, no amounts, no
 *   confirmations. Whatever is real must be passed in by the caller
 *   from the order record.
 * - A pack marked `sample: true` carries a banner stating it is not a
 *   freelancer order, so a format sample can never be mistaken for
 *   track record evidence (internal test payments are recorded in the
 *   test log, never presented as freelancer orders).
 */

export interface OrderEvidenceInput {
  /** Ledger order id; also the per-order folder name. */
  orderId: string;
  orderType: "first" | "repeat";
  /** For a repeat order: reference to the earlier order's pack. */
  previousOrderPackRef?: string;
  orderDateTimeWita: string;
  buyerAgent: {
    name: string;
    erc8004AgentId: string;
    /** 8004scan or registration profile link, when one is published. */
    profileUrl?: string;
  };
  buyerOperator: string;
  /** Self Agent ID check outcome for this order, in words. */
  selfCheckResult: string;
  freelancer: {
    name: string;
    profileUrl?: string;
    location?: string;
    recruitedVia: string;
    screeningConfirmedOn?: string;
  };
  service: {
    title: string;
    description: string;
    /** Agreed price, human USDT string. */
    priceUSDT: string;
    /** Indicative IDRX price at the expected quote rate. */
    priceIDRXIndicative?: string;
    deliveryWindow: string;
    revisionTerms: string;
  };
  freelancerWallet: {
    /** Absent only in samples: renders as a TODO, never as a stand-in address. */
    address?: Address;
    app?: string;
    /** Ownership proof: link or file reference plus the signed text. */
    ownershipProof?: string;
    /** Pre-funding check statement (from runPayoutPreflight). */
    preFundingCheck?: string;
  };
  work: {
    deliveryDateTimeWita?: string;
    deliverableUrl?: string;
    /** SHA-256 of the delivered file. */
    sha256?: string;
    sampleUrl?: string;
    acceptance?: string;
  };
  invoice: {
    url?: string;
    date?: string;
    amountUSDT?: string;
    amountIDRXFinal?: string;
    referencesOrderId?: boolean;
  };
  chain: {
    x402: {
      txHash: Hash;
      amountAndAsset: string;
      payTo: Address;
      /** Builder-code extension note from the 402 response. */
      builderCodeNote?: string;
    };
    conversion?: {
      rfqId: string;
      rateAndFee: string;
      txHash: Hash;
      tagVerified: boolean;
      amountInUSDT: string;
      amountOutIDRX: string;
    };
    payout?: {
      txHash: Hash;
      tagVerified: boolean;
      amountIDRX: string;
      recipient: Address;
    };
    reputation?: {
      txHash: Hash;
    };
  };
  confirmation?: {
    statement?: string;
    form?: string;
    publicPostUrl?: string;
    dateTimeWita?: string;
  };
  receiptsPageUrl?: string;
  completedOn: string;
  completedBy: string;
  /** Marks the pack as a format sample, not a freelancer order. */
  sample?: boolean;
}

const TODO = "TODO: not yet recorded";

function v(value: string | undefined): string {
  return value !== undefined && value !== "" ? value : TODO;
}

function boolWord(value: boolean | undefined): string {
  return value === undefined ? TODO : value ? "yes" : "no";
}

function txLines(hash: Hash): string[] {
  return [`   - Transaction hash: ${hash}`, `   - CeloScan link: ${celoscanTxUrl(hash)}`];
}

const SAMPLE_BANNER = [
  "> **SAMPLE: this is not a freelancer order.** This pack exercises the evidence",
  "> pack writer with real mainnet transactions from the desk's own proof runs, so",
  "> every link in it resolves. No freelancer exists for this sample: the freelancer,",
  "> work, invoice, payout, and confirmation fields are TODO placeholders on purpose.",
  "> The two hashes below are the internal micro order settlement and the treasury",
  "> conversion (EVIDENCE.md sections 11 and 14), transactions between Tanda's own",
  "> wallets. Internal transactions are never track record evidence; they appear here",
  "> only as format filler for the writer, clearly marked.",
].join("\n");

const VERIFICATION_GUIDE = `## Verification guide: check this order yourself in under 5 minutes

Any third party can verify a completed pack with nothing but a browser and the links above.

1. **The freelancer is real (1 minute).** Open the public profile link. It should be a pre-existing account with a history of the skill being sold, not an account created for this order. Open the service listing and compare its title, scope, and price with the invoice. They must match.
2. **The wallet is theirs (1 minute).** Read the signed ownership statement and check that the signing address is exactly the wallet address in this pack. Then open that wallet on CeloScan (paste the address into celoscan.io) and scan its inbound history: the first transfer from any Tanda wallet must be the IDRX payout in this pack, on or after the delivery date. Any earlier inbound transfer from us would break the no pre-funding rule, and it would be visible here.
3. **The work exists (1 minute).** Open the deliverable link and the public work sample. Download the delivered file and check its SHA-256 hash against the hash recorded in this pack. A matching hash proves the sample shown is the file that was delivered for this order, not a substitute added later.
4. **The money moved as described (1 to 2 minutes).** Open the three CeloScan links in order. On the x402 payment, confirm the USDT amount and the payTo address. On the conversion, confirm USDT in and IDRX out at roughly the recorded rate, and that the amounts are consistent with the order price. On the payout, confirm the IDRX amount and that the recipient is the freelancer wallet from step 2, and that the payout timestamp is after the delivery timestamp. For the conversion and the payout, the transaction input data ends with the attribution suffix for celo_f58da6359b7f, which is how the tag appears onchain.
5. **The freelancer confirmed it (under 1 minute).** Open the confirmation link or verify the signed confirmation message against the freelancer wallet address. The confirmation should state, in the freelancer own words, that the work was delivered and the payment was received.

If all five steps check out, the order is genuine: a real person, with their own wallet, did real work, and was really paid, in public.`;

/** Render one order's evidence pack as markdown, following EVIDENCE-PACK.md section by section. */
export function buildEvidencePack(input: OrderEvidenceInput): string {
  const { chain } = input;
  const lines: string[] = [];

  lines.push(`# Tanda: Evidence Pack for Order ${input.orderId}`);
  lines.push("");
  if (input.sample) {
    lines.push(SAMPLE_BANNER);
    lines.push("");
  }

  lines.push("## Order identity");
  lines.push("");
  lines.push(`- Order ID (ledger): ${input.orderId}`);
  lines.push(
    input.orderType === "repeat"
      ? `- Order type: repeat order (earlier order pack: ${v(input.previousOrderPackRef)})`
      : "- Order type: first order",
  );
  lines.push(`- Order date and time (WITA): ${input.orderDateTimeWita}`);
  lines.push(
    `- Buyer agent: ${input.buyerAgent.name}, ERC-8004 agent id ${input.buyerAgent.erc8004AgentId}` +
      (input.buyerAgent.profileUrl
        ? `, profile: ${input.buyerAgent.profileUrl}`
        : ""),
  );
  lines.push(`- Buyer operator (human behind the agent): ${input.buyerOperator}`);
  lines.push(`- Self Agent ID check result for this order: ${input.selfCheckResult}`);
  lines.push("");

  lines.push("## Freelancer");
  lines.push("");
  lines.push(`- Freelancer name (as they agreed to be named publicly): ${input.freelancer.name}`);
  lines.push(`- Public profile link: ${v(input.freelancer.profileUrl)}`);
  lines.push(`- Country and city (only what they agreed to publish): ${v(input.freelancer.location)}`);
  lines.push(`- How we found and recruited them: ${input.freelancer.recruitedVia}`);
  lines.push(
    `- Screening confirmation: passed the screening questions in FREELANCER-RECRUITMENT.md on ${v(input.freelancer.screeningConfirmedOn)}`,
  );
  lines.push("");

  lines.push("## Service listing");
  lines.push("");
  lines.push(`- Service title: ${input.service.title}`);
  lines.push(`- Service description (scope, exactly what will be delivered, format): ${input.service.description}`);
  lines.push(`- Agreed price in USDT: ${input.service.priceUSDT}`);
  lines.push(
    `- Agreed price in IDRX (at the quote rate expected, indicative until the firm quote): ${v(input.service.priceIDRXIndicative)}`,
  );
  lines.push(`- Delivery window agreed (start, deadline): ${input.service.deliveryWindow}`);
  lines.push(`- Revision terms agreed: ${input.service.revisionTerms}`);
  lines.push("");

  lines.push("## Freelancer wallet");
  lines.push("");
  lines.push(`- Freelancer self-custodied Celo wallet address: ${v(input.freelancerWallet.address)}`);
  if (input.freelancerWallet.address) {
    lines.push(`- CeloScan address link: ${celoscanAddressUrl(input.freelancerWallet.address)}`);
  }
  lines.push(`- Wallet app used (as stated by the freelancer): ${v(input.freelancerWallet.app)}`);
  lines.push(`- Ownership proof: ${v(input.freelancerWallet.ownershipProof)}`);
  lines.push(`- Pre-funding check: ${v(input.freelancerWallet.preFundingCheck)}`);
  lines.push("");

  lines.push("## Work delivered");
  lines.push("");
  lines.push(`- Delivery date and time (WITA): ${v(input.work.deliveryDateTimeWita)}`);
  lines.push(`- Deliverable link: ${v(input.work.deliverableUrl)}`);
  lines.push(`- Deliverable content hash (SHA-256): ${v(input.work.sha256)}`);
  lines.push(`- Work sample shown publicly: ${v(input.work.sampleUrl)}`);
  lines.push(`- Acceptance: ${v(input.work.acceptance)}`);
  lines.push("");

  lines.push("## Invoice");
  lines.push("");
  lines.push(`- Invoice issued by the freelancer: ${v(input.invoice.url)}`);
  lines.push(`- Invoice date: ${v(input.invoice.date)}`);
  lines.push(`- Invoice amount in USDT: ${v(input.invoice.amountUSDT)}`);
  lines.push(`- Invoice amount in IDRX (final, at the executed conversion rate): ${v(input.invoice.amountIDRXFinal)}`);
  lines.push(`- Invoice reference to this order ID: ${boolWord(input.invoice.referencesOrderId)}`);
  lines.push("");

  lines.push("## Transaction chain (all links CeloScan, chain 42220)");
  lines.push("");
  lines.push("1. x402 payment (buyer agent pays the desk in USDT):");
  lines.push(...txLines(chain.x402.txHash));
  lines.push(`   - Amount and asset: ${chain.x402.amountAndAsset}`);
  lines.push(`   - PayTo address: ${chain.x402.payTo}`);
  lines.push(
    `   - Note: facilitator settlements do not yet carry the ERC-8021 tag. Builder-code extension declared in the 402 response for this order: ${v(chain.x402.builderCodeNote)}`,
  );
  lines.push("2. Textile FX conversion (USDT to IDRX):");
  if (chain.conversion) {
    lines.push(`   - RFQ quote ID: ${chain.conversion.rfqId}`);
    lines.push(`   - Effective rate and fee from the firm quote: ${chain.conversion.rateAndFee}`);
    lines.push(...txLines(chain.conversion.txHash));
    lines.push(
      `   - Attribution tag verified on this transaction (verifyTx decoded codes include celo_f58da6359b7f): ${boolWord(chain.conversion.tagVerified)}`,
    );
    lines.push(
      `   - Amount in (USDT) and amount out (IDRX): ${chain.conversion.amountInUSDT} USDT in, ${chain.conversion.amountOutIDRX} IDRX out`,
    );
  } else {
    lines.push(`   - ${TODO}`);
  }
  lines.push("3. IDRX payout (desk pays the freelancer wallet):");
  if (chain.payout) {
    lines.push(...txLines(chain.payout.txHash));
    lines.push(
      `   - Attribution tag verified on this transaction (verifyTx decoded codes include celo_f58da6359b7f): ${boolWord(chain.payout.tagVerified)}`,
    );
    lines.push(
      `   - Amount of IDRX and recipient address (must match the freelancer wallet above): ${chain.payout.amountIDRX} IDRX to ${chain.payout.recipient}`,
    );
  } else {
    lines.push(`   - Transaction hash: ${TODO}`);
    lines.push(`   - CeloScan link: ${TODO}`);
    lines.push(
      `   - Attribution tag verified on this transaction (verifyTx decoded codes include celo_f58da6359b7f): ${TODO}`,
    );
    lines.push(
      `   - Amount of IDRX and recipient address (must match the freelancer wallet above): ${TODO}`,
    );
  }
  lines.push("4. Reputation feedback write (ERC-8004, after settlement only):");
  if (chain.reputation) {
    lines.push(...txLines(chain.reputation.txHash));
  } else {
    lines.push(`   - Transaction hash: ${TODO}`);
    lines.push(`   - CeloScan link: ${TODO}`);
  }
  lines.push("");

  lines.push("## Freelancer confirmation of receipt");
  lines.push("");
  lines.push(
    `- Confirmation statement in the freelancer own words (work delivered, payment received, amount, date): ${v(input.confirmation?.statement)}`,
  );
  lines.push(
    `- Form of confirmation: signed message from the freelancer wallet / public post / both: ${v(input.confirmation?.form)}`,
  );
  lines.push(`- Link to the public post, if any: ${v(input.confirmation?.publicPostUrl)}`);
  lines.push(`- Date and time of confirmation (WITA): ${v(input.confirmation?.dateTimeWita)}`);
  lines.push("");

  lines.push("## Public receipt");
  lines.push("");
  lines.push(`- Tanda receipts page entry for this order: ${v(input.receiptsPageUrl)}`);
  lines.push(`- Evidence pack completed on ${input.completedOn}, completed by: ${input.completedBy}`);
  lines.push("");
  lines.push(VERIFICATION_GUIDE);
  lines.push("");

  return lines.join("\n");
}

/**
 * Write one order's evidence pack to `<ordersDir>/<orderId>/EVIDENCE-PACK.md`.
 * Returns the folder and file paths.
 */
export async function writeEvidencePack(
  input: OrderEvidenceInput,
  ordersDir: string,
): Promise<{ dir: string; file: string }> {
  const dir = join(ordersDir, input.orderId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "EVIDENCE-PACK.md");
  await writeFile(file, buildEvidencePack(input), "utf8");
  return { dir, file };
}

/** Default orders folder: `orders/` in the project folder that holds the tanda repo. */
export function defaultOrdersDir(): string {
  // packages/payout/src/evidence.ts -> up four levels is the project
  // folder (celo-agents-open-for-business), which holds orders/.
  return fileURLToPath(new URL("../../../../orders", import.meta.url));
}

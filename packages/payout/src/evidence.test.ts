import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import {
  buildEvidencePack,
  writeEvidencePack,
  type OrderEvidenceInput,
} from "./evidence.js";

const FREELANCER_WALLET =
  "0x1111111111111111111111111111111111111111" as Address;
const X402_HASH = `0x${"aa".repeat(32)}` as Hash;
const CONVERSION_HASH = `0x${"bb".repeat(32)}` as Hash;
const PAYOUT_HASH = `0x${"cc".repeat(32)}` as Hash;

function fullInput(): OrderEvidenceInput {
  return {
    orderId: "order-test-001",
    orderType: "first",
    orderDateTimeWita: "23 Nov 2026, 10:00 WITA",
    buyerAgent: { name: "Tanda Payout Desk Agent", erc8004AgentId: "10094" },
    buyerOperator: "Duan",
    selfCheckResult: "verified and fresh, full tier",
    freelancer: {
      name: "Test Freelancer",
      profileUrl: "https://example.com/freelancer",
      location: "Indonesia, Jakarta",
      recruitedVia: "X open call, 22 Nov 2026",
      screeningConfirmedOn: "23 Nov 2026",
    },
    service: {
      title: "Copy check of Tanda project materials",
      description: "Translate and check about 400 words of project copy.",
      priceUSDT: "1.50",
      priceIDRXIndicative: "27000",
      deliveryWindow: "23 Nov 2026 to 25 Nov 2026",
      revisionTerms: "One revision included",
    },
    freelancerWallet: {
      address: FREELANCER_WALLET,
      app: "Valora",
      ownershipProof: "Signed message on file, text recorded in the order folder",
      preFundingCheck:
        "Pre-flight scan on 23 Nov 2026: no prior IDRX or USDT transfer from the agent or treasury wallet to this address.",
    },
    work: {
      deliveryDateTimeWita: "24 Nov 2026, 09:00 WITA",
      deliverableUrl: "https://example.com/deliverable",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sampleUrl: "https://example.com/sample",
      acceptance: "Accepted by Duan on 24 Nov 2026, no revision requested",
    },
    invoice: {
      url: "https://example.com/invoice",
      date: "24 Nov 2026",
      amountUSDT: "1.50",
      amountIDRXFinal: "27509.88",
      referencesOrderId: true,
    },
    chain: {
      x402: {
        txHash: X402_HASH,
        amountAndAsset: "1.50 USDT",
        payTo: "0x7D6bc7c0DF2d312e6137E78F99107db6Aff1d830" as Address,
        builderCodeNote: "celo_f58da6359b7f declared in the 402 response",
      },
      conversion: {
        rfqId: "rfq_test",
        rateAndFee: "18339.92 IDRX per USDT",
        txHash: CONVERSION_HASH,
        tagVerified: true,
        amountInUSDT: "1.50",
        amountOutIDRX: "27509.88",
      },
      payout: {
        txHash: PAYOUT_HASH,
        tagVerified: true,
        amountIDRX: "27509.88",
        recipient: FREELANCER_WALLET,
      },
      reputation: { txHash: `0x${"dd".repeat(32)}` as Hash },
    },
    confirmation: {
      statement: "Work delivered and payment received, thank you.",
      form: "signed message from the freelancer wallet",
      publicPostUrl: "https://example.com/confirmation-post",
      dateTimeWita: "24 Nov 2026, 12:00 WITA",
    },
    receiptsPageUrl: "https://example.com/receipts/order-test-001",
    completedOn: "24 Nov 2026",
    completedBy: "Glint",
  };
}

describe("buildEvidencePack", () => {
  it("fills every section and renders CeloScan links for all three transactions", () => {
    const pack = buildEvidencePack(fullInput());
    expect(pack).toContain("## Order identity");
    expect(pack).toContain("## Freelancer");
    expect(pack).toContain("## Transaction chain");
    expect(pack).toContain(`https://celoscan.io/tx/${X402_HASH}`);
    expect(pack).toContain(`https://celoscan.io/tx/${CONVERSION_HASH}`);
    expect(pack).toContain(`https://celoscan.io/tx/${PAYOUT_HASH}`);
    expect(pack).toContain(`https://celoscan.io/address/${FREELANCER_WALLET}`);
    expect(pack).toContain(
      "27509.88 IDRX to 0x1111111111111111111111111111111111111111",
    );
    expect(pack).not.toContain("TODO");
  });

  it("includes the full 5-step third-party verification guide", () => {
    const pack = buildEvidencePack(fullInput());
    expect(pack).toContain("1. **The freelancer is real");
    expect(pack).toContain("2. **The wallet is theirs");
    expect(pack).toContain("3. **The work exists");
    expect(pack).toContain("4. **The money moved as described");
    expect(pack).toContain("5. **The freelancer confirmed it");
  });

  it("renders TODO placeholders, never blanks or inventions, for a missing payout", () => {
    const input = fullInput();
    delete input.chain.payout;
    const pack = buildEvidencePack(input);
    const payoutSection = pack.split("3. IDRX payout")[1].split("4.")[0];
    expect(payoutSection).toContain("TODO");
    expect(payoutSection).not.toContain("celoscan.io/tx/0x");
  });

  it("carries the SAMPLE banner only when marked as a sample", () => {
    const sampled = buildEvidencePack({ ...fullInput(), sample: true });
    expect(sampled).toContain("SAMPLE: this is not a freelancer order");
    const real = buildEvidencePack(fullInput());
    expect(real).not.toContain("SAMPLE");
  });

  it("links a repeat order back to the earlier pack", () => {
    const pack = buildEvidencePack({
      ...fullInput(),
      orderType: "repeat",
      previousOrderPackRef: "orders/order-test-001/EVIDENCE-PACK.md",
    });
    expect(pack).toContain("repeat order (earlier order pack: orders/order-test-001/EVIDENCE-PACK.md)");
  });
});

describe("writeEvidencePack", () => {
  it("writes EVIDENCE-PACK.md into a per-order folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tanda-orders-"));
    const { file } = await writeEvidencePack(fullInput(), dir);
    expect(file).toBe(join(dir, "order-test-001", "EVIDENCE-PACK.md"));
    const written = await readFile(file, "utf8");
    expect(written).toContain("# Tanda: Evidence Pack for Order order-test-001");
  });
});

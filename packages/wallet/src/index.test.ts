import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ATTRIBUTION_CODE,
  assertAttributionCode,
  createTaggedWalletClient,
  decodeAttributionSuffix,
  getAttributionSuffix,
} from "./index.js";

describe("attribution code", () => {
  it("is the exact Loops House issued code", () => {
    expect(ATTRIBUTION_CODE).toBe("celo_f58da6359b7f");
    expect(assertAttributionCode()).toBe(ATTRIBUTION_CODE);
  });

  it("rejects any other code, including a repo derived lookalike", () => {
    expect(() => assertAttributionCode("celo_9a5682501e88")).toThrow(
      /mismatch/,
    );
    expect(() => assertAttributionCode("celo_test1234")).toThrow();
    expect(() => assertAttributionCode("not-a-code")).toThrow();
  });
});

describe("attribution suffix", () => {
  it("round trips: suffix decodes back to the issued code", () => {
    const suffix = getAttributionSuffix();
    const decoded = decodeAttributionSuffix(suffix);
    expect(decoded).not.toBeNull();
    expect(decoded?.codes).toContain(ATTRIBUTION_CODE);
  });

  it("appends to plain calldata without changing the prefix", () => {
    const callData = "0xa9059cbb" as const;
    const tagged = (callData + getAttributionSuffix().slice(2)) as `0x${string}`;
    const decoded = decodeAttributionSuffix(tagged);
    expect(tagged.startsWith(callData)).toBe(true);
    expect(decoded?.codes).toContain(ATTRIBUTION_CODE);
  });
});

describe("wallet factory", () => {
  it("builds a client for Celo mainnet from a throwaway key", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const client = createTaggedWalletClient({ account });
    expect(client.chain?.id).toBe(42220);
    expect(client.account?.address).toBe(account.address);
    expect(typeof client.sendTransaction).toBe("function");
    expect(typeof client.writeContract).toBe("function");
  });

  it("refuses to build a client with a non issued code", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(() =>
      createTaggedWalletClient({ account, code: "celo_000000000000" }),
    ).toThrow(/mismatch/);
  });
});

import { describe, expect, it } from "vitest";
import {
  IDRX_DECIMALS,
  ONE_IDRX,
  ONE_USDT,
  USDT_DECIMALS,
  assertIDRXPrecision,
  assertUSDTPrecision,
  convertUSDTToIDRX,
  formatIDRX,
  formatUSDT,
  parseIDRX,
  parseUSDT,
  quoteUSDTToIDRX,
} from "./index.js";

describe("decimal constants", () => {
  it("pins USDT at 6 decimals and IDRX at 2 decimals", () => {
    expect(USDT_DECIMALS).toBe(6);
    expect(IDRX_DECIMALS).toBe(2);
    expect(ONE_USDT).toBe(1_000_000n);
    expect(ONE_IDRX).toBe(100n);
    // The whole point of this module: the raw scales differ by 10,000.
    expect(ONE_USDT / ONE_IDRX).toBe(10_000n);
  });
});

describe("parse and format USDT", () => {
  it("parses whole and fractional dollars", () => {
    expect(parseUSDT("1")).toBe(1_000_000n);
    expect(parseUSDT("0.10")).toBe(100_000n);
    expect(parseUSDT("1.50")).toBe(1_500_000n);
    expect(parseUSDT("0.000001")).toBe(1n);
  });

  it("formats back to a human string", () => {
    expect(formatUSDT(1_000_000n)).toBe("1");
    expect(formatUSDT(100_000n)).toBe("0.1");
    expect(formatUSDT(1n)).toBe("0.000001");
  });

  it("round trips without loss", () => {
    for (const value of ["0.01", "0.50", "1", "2.00", "123.456789"]) {
      expect(formatUSDT(parseUSDT(value))).toBe(
        String(Number(value)),
      );
    }
  });
});

describe("parse and format IDRX", () => {
  it("parses rupiah amounts at 2 decimals", () => {
    expect(parseIDRX("1")).toBe(100n);
    expect(parseIDRX("16000")).toBe(1_600_000n);
    expect(parseIDRX("16000.50")).toBe(1_600_050n);
    expect(parseIDRX("0.01")).toBe(1n);
  });

  it("formats back to a human string", () => {
    expect(formatIDRX(100n)).toBe("1");
    expect(formatIDRX(1_600_000n)).toBe("16000");
    expect(formatIDRX(1n)).toBe("0.01");
  });

  it("round trips without loss", () => {
    for (const value of ["1", "100.25", "16000", "32000.50"]) {
      expect(formatIDRX(parseIDRX(value))).toBe(String(Number(value)));
    }
  });
});

describe("the 10,000 factor trap", () => {
  it("one dollar is NOT one IDRX in raw units", () => {
    // A naive raw to raw copy would send 1_000_000 IDRX raw units,
    // which is 10,000 IDRX, for a 1 USDT payment. These assertions make
    // that class of bug fail loudly in CI instead of silently onchain.
    expect(parseUSDT("1")).not.toBe(parseIDRX("1"));
    expect(parseUSDT("1")).toBe(parseIDRX("1") * 10_000n);
  });

  it("rejects IDRX amounts with more than 2 decimal places", () => {
    expect(() => assertIDRXPrecision("100.001")).toThrow(/2 decimal/);
    expect(() => assertIDRXPrecision("100.01")).not.toThrow();
  });

  it("rejects malformed and negative amounts", () => {
    expect(() => parseUSDT("-1")).toThrow();
    expect(() => parseUSDT("1,000")).toThrow();
    expect(() => parseIDRX("abc")).toThrow();
    expect(() => assertUSDTPrecision("0.0000001")).toThrow(/6 decimal/);
  });
});

describe("USDT to IDRX conversion at a quoted rate", () => {
  // Rate used in tests: 16,000 IDRX per 1 USDT, scaled by 10^6.
  const RATE = 16_000_000_000n;

  it("converts 1 USDT to 16,000 IDRX exactly", () => {
    const idrxRaw = convertUSDTToIDRX(parseUSDT("1"), RATE);
    expect(idrxRaw).toBe(parseIDRX("16000"));
    expect(formatIDRX(idrxRaw)).toBe("16000");
  });

  it("converts the hackathon payout sizes, 1 and 2 dollars", () => {
    expect(formatIDRX(convertUSDTToIDRX(parseUSDT("2"), RATE))).toBe("32000");
    expect(formatIDRX(convertUSDTToIDRX(parseUSDT("0.50"), RATE))).toBe(
      "8000",
    );
  });

  it("never rounds a payout up", () => {
    // 0.01 USDT at a rate of 15,999.99 IDRX per USDT is 159.9999 IDRX,
    // which must truncate to 159.99, never round to 160.00.
    const awkwardRate = 15_999_990_000n;
    expect(formatIDRX(convertUSDTToIDRX(parseUSDT("0.01"), awkwardRate))).toBe(
      "159.99",
    );
  });

  it("rejects a non positive rate and negative amounts", () => {
    expect(() => convertUSDTToIDRX(parseUSDT("1"), 0n)).toThrow();
    expect(() => convertUSDTToIDRX(-1n, RATE)).toThrow();
  });

  it("string quote helper agrees with the bigint path", () => {
    const quote = quoteUSDTToIDRX("1.50", "16000");
    expect(quote.usdtRaw).toBe(1_500_000n);
    expect(quote.idrxRaw).toBe(parseIDRX("24000"));
    expect(quote.idrx).toBe("24000");
  });
});

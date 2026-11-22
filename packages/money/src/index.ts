import { formatUnits, parseUnits } from "viem";

/**
 * Money conversions for Tanda. This module is the ONLY place in the
 * codebase that knows token decimals. Every USDT and IDRX amount in the
 * server, the buyer agent, and the payout worker passes through here.
 *
 * Why this exists: USDT on Celo has 6 decimals and IDRX has 2 decimals.
 * The raw unit ratio between one whole USDT and one whole IDRX is
 * 10^(6-2) = 10,000. Mixing the two scales up is the highest risk silent
 * bug in this project: it loses or multiplies money by a factor of 10,000
 * with no error anywhere. The unit tests in index.test.ts pin the exact
 * behaviour, including that factor.
 *
 * Addresses, for reference (Celo mainnet, chain 42220):
 * USDT: 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e
 * IDRX: 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22
 */

export const USDT_DECIMALS = 6;
export const IDRX_DECIMALS = 2;

export const USDT_ADDRESS =
  "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
export const IDRX_ADDRESS =
  "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22" as const;

/** Raw units in one whole token, per asset. */
export const ONE_USDT = 10n ** BigInt(USDT_DECIMALS); // 1_000_000n
export const ONE_IDRX = 10n ** BigInt(IDRX_DECIMALS); // 100n

function assertDecimalString(value: string, asset: string): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `${asset} amount "${value}" is not a plain non negative decimal string. ` +
        "Pass amounts as strings, never as floats, to avoid binary rounding.",
    );
  }
  return trimmed;
}

/** "1.50" USDT -> 1_500_000n raw units. Throws on malformed input. */
export function parseUSDT(value: string): bigint {
  return parseUnits(assertDecimalString(value, "USDT"), USDT_DECIMALS);
}

/** 1_500_000n raw units -> "1.5" USDT. */
export function formatUSDT(raw: bigint): string {
  return formatUnits(raw, USDT_DECIMALS);
}

/** "16000.50" IDRX -> 1_600_050n raw units (2 decimals, rupiah cents). */
export function parseIDRX(value: string): bigint {
  return parseUnits(assertDecimalString(value, "IDRX"), IDRX_DECIMALS);
}

/** 1_600_050n raw units -> "16000.5" IDRX. */
export function formatIDRX(raw: bigint): string {
  return formatUnits(raw, IDRX_DECIMALS);
}

/**
 * Reject USDT strings with more precision than the token supports, instead
 * of letting a parser silently truncate a payment amount.
 */
export function assertUSDTPrecision(value: string): void {
  const [, fraction = ""] = assertDecimalString(value, "USDT").split(".");
  if (fraction.length > USDT_DECIMALS) {
    throw new Error(
      `USDT amount "${value}" has more than ${USDT_DECIMALS} decimal places.`,
    );
  }
}

/** Same precision guard for IDRX, which only supports 2 decimal places. */
export function assertIDRXPrecision(value: string): void {
  const [, fraction = ""] = assertDecimalString(value, "IDRX").split(".");
  if (fraction.length > IDRX_DECIMALS) {
    throw new Error(
      `IDRX amount "${value}" has more than ${IDRX_DECIMALS} decimal places. ` +
        "Round deliberately at the quote step, never silently.",
    );
  }
}

/**
 * Convert a USDT raw amount to an IDRX raw amount at a quoted rate.
 *
 * The rate is expressed as IDRX per 1 USDT, scaled by 10^rateDecimals
 * (default 6). Example: a rate of 16,000 IDRX per USDT is passed as
 * rateScaled = 16_000_000_000n with the default scaling.
 *
 * Formula, all in bigint so there is no float anywhere near money:
 *   idrxRaw = usdtRaw * rateScaled / (10^USDT_DECIMALS * 10^rateDecimals / 10^IDRX_DECIMALS)
 * which simplifies to usdtRaw * rateScaled / 10^(rateDecimals + 4).
 * The +4 is exactly the 10,000 factor between the two decimal scales.
 * Division truncates toward zero: the desk never pays out more IDRX than
 * the quote supports. Callers compare against their floor rate before
 * calling this, per the payout flow in CONCEPT.md.
 */
export function convertUSDTToIDRX(
  usdtRaw: bigint,
  rateScaled: bigint,
  rateDecimals = 6,
): bigint {
  if (usdtRaw < 0n) throw new Error("USDT amount cannot be negative.");
  if (rateScaled <= 0n) throw new Error("Rate must be positive.");
  const divisor = 10n ** BigInt(rateDecimals + USDT_DECIMALS - IDRX_DECIMALS);
  return (usdtRaw * rateScaled) / divisor;
}

/** Convenience wrapper taking human strings, for quotes and tests. */
export function quoteUSDTToIDRX(
  usdtAmount: string,
  rateIdrxPerUsdt: string,
): { usdtRaw: bigint; idrxRaw: bigint; idrx: string } {
  assertUSDTPrecision(usdtAmount);
  const usdtRaw = parseUSDT(usdtAmount);
  const rateScaled = parseUnits(
    assertDecimalString(rateIdrxPerUsdt, "rate"),
    6,
  );
  const idrxRaw = convertUSDTToIDRX(usdtRaw, rateScaled, 6);
  return { usdtRaw, idrxRaw, idrx: formatIDRX(idrxRaw) };
}

import {
  fromDataSuffix,
  toDataSuffix,
  verifyTx,
  withAttribution,
} from "@celo/attribution-tags";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { celo } from "viem/chains";

/**
 * The exact attribution code issued by Loops House at enrollment for Tanda.
 *
 * Source of truth: ENROLLMENT.md in the project folder, captured from the
 * Loops House playground on 22 Nov 2026.
 *
 * Per BUILDERS.md (celo-org/attribution-tags): a program assigned code must
 * be the code in the suffix. This code is NOT the codeFromRepo derivation
 * for the GitHub repo slug, so this module asserts the exact issued code
 * instead of asserting a repo derivation. Do not replace this constant with
 * codeFromRepo(...) or codeFromHostname(...): a self derived code is a
 * different value and would silently never be credited.
 */
export const ATTRIBUTION_CODE = "celo_f58da6359b7f";

export const CELO_CHAIN_ID = 42220;
export const DEFAULT_CELO_RPC_URL = "https://forno.celo.org";

const ISSUED_CODE_PATTERN = /^celo_[a-f0-9]{12}$/;

/**
 * Fail fast if the code in use is not the exact issued code. Called by the
 * wallet factory on every client construction, so a stale or copied code
 * can never quietly tag transactions that credit nobody.
 */
export function assertAttributionCode(code: string = ATTRIBUTION_CODE): string {
  if (!ISSUED_CODE_PATTERN.test(code)) {
    throw new Error(
      `Attribution code "${code}" is not a well formed issued code (celo_ plus 12 hex chars).`,
    );
  }
  if (code !== ATTRIBUTION_CODE) {
    throw new Error(
      `Attribution code mismatch: got "${code}", expected the Loops House issued code "${ATTRIBUTION_CODE}". ` +
        "Transactions tagged with any other code are never credited to this entry.",
    );
  }
  return code;
}

/** The ERC-8021 data suffix for the issued code, for manual call sites. */
export function getAttributionSuffix(code: string = ATTRIBUTION_CODE): Hex {
  assertAttributionCode(code);
  return toDataSuffix(code) as Hex;
}

/** Decode a data suffix back to its codes. Returns null when untagged. */
export function decodeAttributionSuffix(data: Hex) {
  return fromDataSuffix(data);
}

export interface TaggedWalletOptions {
  account: Account;
  /** Defaults to the public Celo RPC. */
  rpcUrl?: string;
  /** Override transport, for tests or a custom provider. */
  transport?: Transport;
  /** Override the code, only for tests. Must equal the issued code. */
  code?: string;
}

/**
 * THE wallet client factory for Tanda. This is the only place in the
 * codebase where a wallet client is created.
 *
 * It follows the recommended setup in BUILDERS.md exactly: the attribution
 * extension is attached where the client is built, with
 * createWalletClient(...).extend(withAttribution(code)), not at each call
 * site. The guide is explicit that the common failure is a call path that
 * never appended the suffix, and that attaching at construction is the fix.
 * withAttribution wraps sendTransaction, writeContract, and their Sync
 * variants on the returned client.
 *
 * Rule for the whole repo: never call createWalletClient anywhere else.
 */
export function createTaggedWalletClient(options: TaggedWalletOptions) {
  const code = assertAttributionCode(options.code ?? ATTRIBUTION_CODE);
  const transport =
    options.transport ?? http(options.rpcUrl ?? DEFAULT_CELO_RPC_URL);
  return createWalletClient({
    account: options.account,
    chain: celo,
    transport,
  }).extend(withAttribution(code));
}

export function createCeloPublicClient(
  rpcUrl: string = DEFAULT_CELO_RPC_URL,
) {
  return createPublicClient({ chain: celo, transport: http(rpcUrl) });
}

/** The public client type the attribution SDK itself expects for verifyTx. */
export type AttributionPublicClient = Parameters<typeof verifyTx>[0]["client"];

export interface TaggedTxResult {
  /** True only when the issued code is present onchain for this hash. */
  tagged: boolean;
  codes: string[];
  schemaId: number | null;
}

/**
 * verifyTx style check, per BUILDERS.md "Verifying it worked".
 * verifyTx returns null (never throws) when the marker is not there.
 * This wrapper adds the one check that matters for the hackathon: the
 * decoded codes must include the exact issued code.
 */
export async function verifyTaggedTx(
  client: AttributionPublicClient,
  hash: Hex,
): Promise<TaggedTxResult> {
  const result = await verifyTx({ client, hash });
  if (!result) {
    return { tagged: false, codes: [], schemaId: null };
  }
  const codes = [...result.codes];
  return {
    tagged: codes.includes(ATTRIBUTION_CODE),
    codes,
    schemaId: result.schemaId ?? null,
  };
}

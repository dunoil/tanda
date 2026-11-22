import {
  encodeFunctionData,
  parseEventLogs,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import {
  createCeloPublicClient,
  createTaggedWalletClient,
} from "@tanda/wallet";

/**
 * ERC-8004 agent registration for Tanda.
 *
 * Built exactly on the flow in the Celo docs
 * (https://docs.celo.org/build-on-celo/build-with-ai/8004, "Register a
 * service"):
 *
 *   1. Publish the agent registration file WITHOUT the `registrations`
 *      block. The agent id only exists once the registration is mined.
 *   2. Call `register(agentURI)` on the Identity Registry. register()
 *      sets the agent wallet to the sending address.
 *   3. Read the agent id from the `Registered` event on the transaction
 *      receipt. Never from the simulated return value: the docs are
 *      explicit that the simulated value is `_lastId` at simulation time
 *      and is wrong the moment another registration lands first.
 *   4. Update the hosted file with the id in `registrations`, and if the
 *      URI changed (IPFS or data: URIs change when the file changes),
 *      point the registry at the new file with `setAgentURI(agentId, uri)`.
 *
 * Every send goes through createTaggedWalletClient in @tanda/wallet, the
 * single factory that attaches the Loops House attribution code
 * (celo_f58da6359b7f) at client construction, so a registration sent from
 * here is tagged by construction.
 *
 * FUNDING BLOCKER (see STATUS.md in this package): the agent wallet
 * 0xed328f847eF33f35148513DCEFB10069FcE53725 is not funded yet, so the
 * live path in this module cannot run. Gas per registry write is about
 * 0.05 CELO (see the budget in BUILD-PLAN.md). Until Duan funds the
 * wallet, only the dry run path below is usable: it builds and prints
 * the exact transaction without sending anything.
 */

export const IDENTITY_REGISTRY_MAINNET =
  "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const REPUTATION_REGISTRY_MAINNET =
  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;
export const IDENTITY_REGISTRY_SEPOLIA =
  "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
export const REPUTATION_REGISTRY_SEPOLIA =
  "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const;

export const CELO_MAINNET_CHAIN_ID = 42220;
export const CELO_SEPOLIA_CHAIN_ID = 11142220;

export const IDENTITY_REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

/** One service endpoint entry in the registration file. Names are examples, not a closed list, per the docs. */
export interface AgentServiceEntry {
  name: string;
  endpoint: string;
  version?: string;
}

export interface AgentRegistration {
  agentId: number;
  /** EIP-155 registry reference, format: {namespace}:{chainId}:{registry address}. */
  agentRegistry: string;
}

export interface AgentRegistrationFile {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: AgentServiceEntry[];
  x402Support: boolean;
  active: boolean;
  registrations: AgentRegistration[];
  supportedTrust: string[];
}

export const REGISTRATION_FILE_TYPE =
  "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** The registry reference string used inside the registration file. */
export function agentRegistryRef(
  chainId: number,
  registry: Address = IDENTITY_REGISTRY_MAINNET,
): string {
  return `eip155:${chainId}:${registry}`;
}

/**
 * Step 1 of the docs flow: build the registration file to publish BEFORE
 * registering. `registrations` starts empty on purpose: the agent id does
 * not exist yet, and a file that claims one in advance is wrong.
 */
export function buildRegistrationFile(input: {
  name: string;
  description: string;
  services: AgentServiceEntry[];
  image?: string;
  x402Support?: boolean;
  active?: boolean;
}): AgentRegistrationFile {
  return {
    type: REGISTRATION_FILE_TYPE,
    name: input.name,
    description: input.description,
    ...(input.image ? { image: input.image } : {}),
    services: input.services,
    x402Support: input.x402Support ?? false,
    active: input.active ?? true,
    registrations: [],
    supportedTrust: ["reputation"],
  };
}

/**
 * Step 4 of the docs flow: return a copy of the file with the mined agent
 * id added to `registrations`, ready to republish. If republishing moves
 * the file to a new URI, follow up with a setAgentURI transaction.
 */
export function withRegistration(
  file: AgentRegistrationFile,
  agentId: bigint | number,
  chainId: number = CELO_MAINNET_CHAIN_ID,
  registry: Address = IDENTITY_REGISTRY_MAINNET,
): AgentRegistrationFile {
  return {
    ...file,
    registrations: [
      ...file.registrations,
      { agentId: Number(agentId), agentRegistry: agentRegistryRef(chainId, registry) },
    ],
  };
}

/** The exact calldata for register(agentURI). Pure, so the dry run and the tests need no chain. */
export function buildRegisterCalldata(agentURI: string): Hex {
  return encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [agentURI],
  });
}

/** The exact calldata for setAgentURI(agentId, newURI). */
export function buildSetAgentURICalldata(agentId: bigint, newURI: string): Hex {
  return encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "setAgentURI",
    args: [agentId, newURI],
  });
}

export interface DryRunTx {
  mode: "dry-run";
  /** Registry the transaction would be sent to. */
  to: Address;
  /** Full calldata, including the attribution suffix once sent through the tagged client. */
  data: Hex;
  /** Calldata before the attribution suffix is appended at send time. */
  dataWithoutSuffix: Hex;
  chainId: number;
  from: Address;
  note: string;
}

export interface RegisterAgentOptions {
  account: Account;
  agentURI: string;
  registry?: Address;
  rpcUrl?: string;
  /**
   * When true (the default), build and print the transaction and send
   * nothing. Live sends must opt in explicitly with dryRun: false, and
   * even then they fail until the wallet is funded.
   */
  dryRun?: boolean;
  /** Injected in tests. Defaults to a tagged wallet client and its public counterpart. */
  clients?: RegistrationClients;
}

export interface RegistrationClients {
  walletClient: {
    writeContract: (args: Record<string, unknown>) => Promise<Hash>;
  };
  publicClient: {
    waitForTransactionReceipt: (args: {
      hash: Hash;
    }) => Promise<TransactionReceipt>;
  };
}

const DRY_RUN_NOTE =
  "Dry run: nothing was sent. The data shown is the register(agentURI) calldata before the " +
  "attribution suffix, which the tagged wallet client appends at send time. " +
  "Sending is blocked until the agent wallet is funded (see STATUS.md).";

/** Build the dry run transaction for register(agentURI). Never sends. */
export function buildRegisterDryRun(input: {
  from: Address;
  agentURI: string;
  registry?: Address;
  chainId?: number;
}): DryRunTx {
  const data = buildRegisterCalldata(input.agentURI);
  return {
    mode: "dry-run",
    to: input.registry ?? IDENTITY_REGISTRY_MAINNET,
    data,
    dataWithoutSuffix: data,
    chainId: input.chainId ?? CELO_MAINNET_CHAIN_ID,
    from: input.from,
    note: DRY_RUN_NOTE,
  };
}

/** Print a dry run transaction in a stable, greppable shape. */
export function formatDryRun(tx: DryRunTx): string {
  return [
    "ERC-8004 register(agentURI) dry run",
    `  mode:    ${tx.mode} (nothing sent)`,
    `  chainId: ${tx.chainId}`,
    `  from:    ${tx.from}`,
    `  to:      ${tx.to}`,
    `  data:    ${tx.data}`,
    `  note:    ${tx.note}`,
  ].join("\n");
}

/**
 * Extract the agent id from a registration receipt by decoding its
 * `Registered` event, exactly as the docs require. Throws when the event
 * is absent, because any other source for the id is unreliable.
 */
export function parseAgentIdFromReceipt(
  receipt: Pick<TransactionReceipt, "logs">,
): bigint {
  const events = parseEventLogs({
    abi: IDENTITY_REGISTRY_ABI,
    eventName: "Registered",
    logs: receipt.logs as Log[],
  });
  if (events.length === 0) {
    throw new Error(
      "No Registered event in the receipt. Refusing to guess the agent id: " +
        "the docs warn that the simulated register() return value is _lastId at " +
        "simulation time and goes wrong when another registration lands first.",
    );
  }
  return events[0].args.agentId;
}

export interface RegisterAgentResult {
  txHash: Hash;
  agentId: bigint;
  registry: Address;
}

/**
 * Live registration. Sends register(agentURI) through the tagged wallet
 * factory, waits for the receipt, and reads the agent id from the
 * `Registered` event.
 *
 * Blocked in practice until the agent wallet is funded: the send will
 * revert or fail with insufficient funds before that. Callers should use
 * the dry run (registerAgentDryRun) until funding lands.
 */
export async function registerAgent(
  options: RegisterAgentOptions,
): Promise<RegisterAgentResult | DryRunTx> {
  const registry = options.registry ?? IDENTITY_REGISTRY_MAINNET;
  if (options.dryRun !== false) {
    return buildRegisterDryRun({
      from: options.account.address,
      agentURI: options.agentURI,
      registry,
    });
  }
  const clients =
    options.clients ?? defaultClients(options.account, options.rpcUrl);
  const txHash = await clients.walletClient.writeContract({
    address: registry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [options.agentURI],
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  return { txHash, agentId: parseAgentIdFromReceipt(receipt), registry };
}

function defaultClients(
  account: Account,
  rpcUrl?: string,
): RegistrationClients {
  const walletClient = createTaggedWalletClient({ account, rpcUrl });
  const publicClient = createCeloPublicClient(rpcUrl);
  return {
    walletClient: walletClient as unknown as RegistrationClients["walletClient"],
    publicClient: publicClient as unknown as RegistrationClients["publicClient"],
  };
}

/** Convenience wrapper used by the CLI script: always a dry run unless told otherwise. */
export async function registerAgentDryRun(input: {
  account: Account;
  agentURI: string;
  registry?: Address;
}): Promise<string> {
  const tx = buildRegisterDryRun({
    from: input.account.address,
    agentURI: input.agentURI,
    registry: input.registry,
  });
  return formatDryRun(tx);
}

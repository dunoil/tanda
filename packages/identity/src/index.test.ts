import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  IDENTITY_REGISTRY_ABI,
  IDENTITY_REGISTRY_MAINNET,
  agentRegistryRef,
  buildRegisterCalldata,
  buildRegistrationFile,
  buildRegisterDryRun,
  parseAgentIdFromReceipt,
  registerAgent,
  withRegistration,
} from "./index.js";

const URI = "https://dunoil.github.io/tanda/agent-registration.json";

describe("registration file (docs step 1)", () => {
  it("starts with an empty registrations block", () => {
    const file = buildRegistrationFile({
      name: "Tanda",
      description: "Payout desk agent",
      services: [{ name: "web", endpoint: "https://example.com" }],
      x402Support: true,
    });
    expect(file.registrations).toEqual([]);
    expect(file.x402Support).toBe(true);
    expect(file.active).toBe(true);
    expect(file.type).toContain("eip-8004");
  });

  it("adds the mined id with the EIP-155 registry reference (docs step 4)", () => {
    const file = withRegistration(
      buildRegistrationFile({
        name: "Tanda",
        description: "Payout desk agent",
        services: [],
      }),
      42n,
    );
    expect(file.registrations).toEqual([
      {
        agentId: 42,
        agentRegistry: `eip155:42220:${IDENTITY_REGISTRY_MAINNET}`,
      },
    ]);
    expect(agentRegistryRef(42220)).toBe(
      `eip155:42220:${IDENTITY_REGISTRY_MAINNET}`,
    );
  });
});

describe("register calldata", () => {
  it("encodes register(agentURI) for the canonical mainnet registry", () => {
    const data = buildRegisterCalldata(URI);
    const decoded = decodeFunctionData({
      abi: IDENTITY_REGISTRY_ABI,
      data,
    });
    expect(decoded.functionName).toBe("register");
    expect(decoded.args).toEqual([URI]);
  });
});

describe("dry run", () => {
  it("builds the transaction and sends nothing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const writeContract = vi.fn(async () => {
      throw new Error("writeContract must never be called in a dry run");
    });
    const result = await registerAgent({
      account,
      agentURI: URI,
      clients: {
        walletClient: { writeContract },
        publicClient: {
          waitForTransactionReceipt: vi.fn(async () => {
            throw new Error("no receipt in a dry run");
          }),
        },
      },
    });
    expect(writeContract).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "dry-run", to: IDENTITY_REGISTRY_MAINNET });
    if ("mode" in result) {
      expect(result.data).toBe(buildRegisterCalldata(URI));
      expect(result.from).toBe(account.address);
    }
  });

  it("buildRegisterDryRun is pure and labelled", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const tx = buildRegisterDryRun({ from: account.address, agentURI: URI });
    expect(tx.chainId).toBe(42220);
    expect(tx.note).toContain("nothing was sent");
  });
});

describe("agent id from the Registered event (docs step 3)", () => {
  it("reads the id from the event, never from a simulated return", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const topics = encodeEventTopics({
      abi: IDENTITY_REGISTRY_ABI,
      eventName: "Registered",
      args: { agentId: 7n, owner: account.address },
    });
    const data = encodeAbiParameters(parseAbiParameters("string"), [URI]);
    const receipt = {
      logs: [
        {
          address: IDENTITY_REGISTRY_MAINNET,
          topics,
          data,
          blockNumber: 1n,
          blockHash: `0x${"00".repeat(32)}` as const,
          transactionHash: `0x${"11".repeat(32)}` as const,
          transactionIndex: 0,
          logIndex: 0,
          removed: false,
        },
      ],
    } as unknown as Parameters<typeof parseAgentIdFromReceipt>[0];
    expect(parseAgentIdFromReceipt(receipt)).toBe(7n);
  });

  it("throws when the receipt has no Registered event", () => {
    const receipt = { logs: [] } as unknown as Parameters<
      typeof parseAgentIdFromReceipt
    >[0];
    expect(() => parseAgentIdFromReceipt(receipt)).toThrow(/No Registered event/);
  });
});

describe("live path with injected clients", () => {
  it("sends through writeContract and returns the event id", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const topics = encodeEventTopics({
      abi: IDENTITY_REGISTRY_ABI,
      eventName: "Registered",
      args: { agentId: 9n, owner: account.address },
    });
    const data = encodeAbiParameters(parseAbiParameters("string"), [URI]);
    const hash = `0x${"22".repeat(32)}` as const;
    const writeContract = vi.fn(async () => hash);
    const result = await registerAgent({
      account,
      agentURI: URI,
      dryRun: false,
      clients: {
        walletClient: { writeContract },
        publicClient: {
          waitForTransactionReceipt: vi.fn(
            async () =>
              ({
                logs: [
                  {
                    address: IDENTITY_REGISTRY_MAINNET,
                    topics,
                    data,
                    blockNumber: 1n,
                    blockHash: `0x${"00".repeat(32)}` as const,
                    transactionHash: hash,
                    transactionIndex: 0,
                    logIndex: 0,
                    removed: false,
                  },
                ],
              }) as unknown as import("viem").TransactionReceipt,
          ),
        },
      },
    });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ txHash: hash, agentId: 9n });
  });
});

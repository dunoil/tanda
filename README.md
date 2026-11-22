# Tanda: Human-Signed Agent Payouts to Rupiah

Tanda is a payout desk on Celo where an AI agent can only move money if a verified human stands behind it: the agent pays in USDT over x402, Tanda checks its Self Agent ID proof before serving it, converts the dollars to IDRX over Textile FX, and pays an Indonesian freelancer in rupiah stablecoin, with a public onchain receipt for every step.

Tanda is the Indonesian word for a sign, a mark, or a proof. The product is literally about a human mark behind an agent.

Built for the [Celo Agents Open for Business hackathon on Loops House](https://www.loops.house/agents-open-for-business). Submission deadline: 7 Dec 2026, 09:00 GMT. Tracks entered:

- Verified Agent Payments (Self Agent ID): identity is the payout policy. The desk verifies the agent's Self proof before serving it, and keys daily caps to the human nullifier behind the agent, not to the agent key.
- Stablecoin Corridors (Textile FX): USDT in, IDRX out. A real FX conversion through the Textile RFQ rail, paid to a named freelancer outside the team.

## How it works

1. A buyer agent calls the desk with a SelfAgent signed request.
2. The desk verifies the Self Agent ID proof against the Self registry on Celo mainnet. No proof, no payout endpoint: HTTP 403 with a reason code. Proof present but stale: a reduced trial limit. Verified and fresh: full limits.
3. On a pass, the desk answers HTTP 402 with a priced payment requirement in USDT on Celo mainnet. The buyer pays through the Celo x402 facilitator and the facilitator settles onchain.
4. When the freelancer's job completes, the desk requests a firm Textile RFQ quote for USDT to IDRX, checks the effective rate against the job's floor rate, and broadcasts the conversion from its own wallet.
5. The desk transfers the IDRX to the freelancer's wallet and writes ERC-8004 reputation feedback for the buyer agent, only after a settled job.
6. Every step lands on the public receipts page with Celoscan links.

## Attribution

Every transaction Tanda itself sends carries the Loops House attribution tag for this entry, issued at enrollment:

- Code: celo_f58da6359b7f

Implementation, following the official guide at celo-org/attribution-tags (BUILDERS.md) exactly:

- There is exactly one wallet client factory, in packages/wallet. It builds the viem client and attaches the tag at construction with createWalletClient(...).extend(withAttribution(code)), so every sendTransaction and writeContract call on that client is tagged with no per call changes needed.
- The factory asserts the exact issued code at startup and on every client construction. This issued code is not the codeFromRepo derivation for this repo slug, and the guide is clear that a program assigned code must be the code in the suffix, so the factory checks the issued value, not a derivation.
- The first transaction of each kind is decoded with verifyTx (wrapped by verifyTaggedTx in packages/wallet) and logged as evidence before the next kind is attempted.
- One honest exception, documented in the guide itself: x402 settlements are submitted by the Celo facilitator, which does not write attribution tags into its settlement transactions yet. Tanda declares its code in the builder-code extension of its 402 responses, which the guide says is picked up automatically once facilitator tagging ships. The conversion and payout transactions, which Tanda sends itself, are the primary tagged evidence.

## Money handling

USDT on Celo has 6 decimals. IDRX has 2 decimals. That difference is a factor of 10,000 in raw units and is the easiest silent bug in this stack, so all amount parsing, formatting, and conversion lives in one module, packages/money, with unit tests that pin the factor. No other package parses a token amount.

Key addresses on Celo mainnet (chain 42220):

- USDT: 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e (6 decimals)
- IDRX: 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22 (2 decimals)
- Textile LimitOrderReactor: 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3
- Self registry: 0xaC3DF9ABf80d0F5c020C06B04Cced27763355944
- ERC-8004 Identity Registry: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432

## Agent wallet

- Agent wallet public address: 0xed328f847eF33f35148513DCEFB10069FcE53725 (also in WALLET.md, public address only). On CeloScan: https://celoscan.io/address/0xed328f847eF33f35148513DCEFB10069FcE53725
- The same agent wallet is kept for the whole event, because the Loops House score is tied to it.
- The private key lives only in a local .env file (mode 600, gitignored). It is never in this repo.

## Layout

- apps/server: the desk. Hono on Node: Self verification middleware (src/self.ts), x402 seller routes (src/x402.ts), Textile client, payout worker, SQLite ledger.
- apps/buyer-agent: a small CLI agent that other operators can copy. It signs requests with its SelfAgent key, pays through x402 (src/pay.ts), and confirms deliveries.
- apps/web: static site. Landing page, service board, and the public receipts explorer.
- packages/wallet: the single tagged wallet client factory, plus the verifyTx check.
- packages/money: USDT and IDRX decimal conversions, with unit tests.
- packages/identity: ERC-8004 registration, following the Celo docs flow, with a dry run mode.
- packages/textile: Textile FX RFQ quote client for USDT to IDRX. Quotes only in the prep build, execution disabled.

## Run it

```bash
npm install
cp .env.example .env   # fill AGENT_PRIVATE_KEY locally, never commit .env
npm test               # unit tests: money conversions and the attribution helper
npm run dev:server     # desk on http://localhost:8787, health at /health
npm run agent -- whoami
```

## Status

Prep build, day 1 of the build (22 Nov 2026): enrollment done, attribution factory and money module built and tested, agent wallet generated and registered on Loops House. Built and tested in this pass, all without mainnet funds: the ERC-8004 registration module with dry run mode, the Self Agent ID gate with mainnet, testnet, and mock modes and a tested refusal path, the x402 seller challenge (402 with the builder code declared) and the buyer payment loop against a stub desk, and the Textile FX quote client with execution deliberately disabled. Blocked on wallet funding (10 CELO plus 6 USDT, amounts in the project BUILD-PLAN.md budget), on Duan creating the x402 facilitator API key with GitHub sign in, and on Duan's Self document scan. The full status, with exact blockers, lives in STATUS.md in the project folder outside this repo, with per package notes in packages/identity/STATUS.md, packages/textile/STATUS.md, and apps/server/STATUS.md.

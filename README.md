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
- packages/textile: Textile FX RFQ quote client for USDT to IDRX. Execution enabled behind the TEXTILE_EXECUTION_ENABLED opt-in; the 1.00 USDT to 18,339.92 IDRX conversion is proven on mainnet.
- packages/payout: IDRX payout from the treasury to a freelancer wallet. Dry run by default, live sends behind the PAYOUT_EXECUTION_ENABLED opt-in, with pre-flight checks including a no prior inbound check on the recipient, plus an evidence pack writer.

## Run it

```bash
npm install
cp .env.example .env   # fill AGENT_PRIVATE_KEY locally, never commit .env
npm test               # unit tests: money conversions and the attribution helper
npm run dev:server     # desk on http://localhost:8787, health at /health
npm run agent -- whoami
```

## Status

Live state, 27 Nov 2026. The full payment loop has run on Celo mainnet end to end except for the final step. Enrollment is done: the agent wallet is registered on Loops House with attribution code celo_f58da6359b7f. ERC-8004 registration is live: agent ID 10094, tx [0xaa95e8648ecf4cdc5d6a0b09c113b15b1e6f13308c180925c562fd51866c0113](https://celoscan.io/tx/0xaa95e8648ecf4cdc5d6a0b09c113b15b1e6f13308c180925c562fd51866c0113), attribution tag verified onchain. Self Agent ID is live: agent ID 207, human proof verified and fresh until 22 Nov 2027, and the desk gate classifies our buyer agent as FULL tier. The first x402 micro order settled on mainnet: 0.10 USDT from the agent wallet to the treasury, tx [0xbb47c7b8500e8e891892a9da905c02618ae324c38fdbadd7ca659e8bdf6a6e05](https://celoscan.io/tx/0xbb47c7b8500e8e891892a9da905c02618ae324c38fdbadd7ca659e8bdf6a6e05). The Textile conversion settled on mainnet: 1.00 USDT converted to exactly 18,339.92 IDRX, tx [0xe160e12791e89091d52ecac641c39caadbfae12b58c841195e106f08981a67cb](https://celoscan.io/tx/0xe160e12791e89091d52ecac641c39caadbfae12b58c841195e106f08981a67cb), and the IDRX sits in the treasury as the first payout float. The payout module (packages/payout) is code-ready and dry-run verified against live mainnet state: pre-flight checks including a no prior inbound check on the recipient, dry run by default, live sends behind an explicit opt-in flag. Full test suite: 98 of 98 pass, typecheck clean in every workspace.

The one step still unproven is the live IDRX transfer to a genuine freelancer. It runs against the first genuine order, after screening, delivery, and acceptance, with the payout announced to Duan in advance under his notify-first rule. Recruiting the first freelancer is the current blocker. The full status, with exact blockers, lives in STATUS.md in the project folder outside this repo, with per package notes in packages/identity/STATUS.md, packages/textile/STATUS.md, packages/payout/STATUS.md, and apps/server/STATUS.md.

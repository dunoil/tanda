# Desk server (Self gate, x402, Textile quotes): status

Date: 22 Nov 2026. Wallet state: NOT funded. No mainnet transaction has been sent, and no x402 settlement has completed.

## Done

- Self Agent ID gate in src/self.ts, on the official @selfxyz/agent-sdk verifier. Modes are explicit and separated: mainnet (the default, real registry 0xaC3DF9ABf80d0F5c020C06B04Cced27763355944, real documents), testnet (Celo Sepolia registry 0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379, mock passports), and mock (local in memory registry with real signature recovery, for tests and offline development; refused when NODE_ENV is production). Policy is a pure function: verified and fresh is full tier, registered but stale is trial tier (served on read and quote routes only), anything else is refused with HTTP 403 and a machine readable reason code. Caps key to the human nullifier from the verification result.
- x402 seller wiring in src/x402.ts, on the v2 packages (@x402/hono, @x402/core, @x402/evm) pointed at the Celo facilitator, exactly per the skill at x402.celo.org/skill.md: explicit USDT price object (amount in raw units from @tanda/money, asset address, EIP-712 name "Tether USD", version "1"), payTo set to the desk wallet, the API key attached only to facilitator calls through createAuthHeaders, and the builder-code extension declaring celo_f58da6359b7f in every 402 response. Verified live in tests: a verified agent with no payment gets a proper 402 whose payment-required header carries the priced requirement and the builder code. The middleware initialize step reads only the facilitator public /supported list, which needs no key.
- Buyer side needs no API key at all, and is complete in apps/buyer-agent (402, sign, retry loop against a stub desk, plus spend control refusal, both tested offline).
- Textile quote route: POST /desk/quote returns a normalized preview quote and the floor rate check, from @tanda/textile. Preview quotes need no key, no proof, and no funds.

## Blocked on Duan: the x402 API key (exact boundary)

No x402 settlement can complete, on mainnet or on testnet, until the API key exists. The boundary is precise:

- The desk answers correct 402 challenges with no key present. The buyer signs and retries with no key. The facilitator then rejects settlement without the seller API key (the metering gate returns 401), and testnet rehearsal of the full loop stops at exactly the same point, because the testnet facilitator is the same metered service.
- The key can only be created by Duan himself: open https://x402.celo.org, connect a wallet, click Create API key, sign the message, and choose Sign in with GitHub to receive the mainnet free credits. Skip yields testnet credits only, and GitHub cannot be added to that key later, so the GitHub path is the one to take even for rehearsal. The key is shown once and goes into the server environment as X402_API_KEY. It is never in the repo and never sent to buyers or browsers.
- There is no programmatic shortcut around this in this build, by design: the skill says the agent job begins after X402_API_KEY is set, and not to mint keys programmatically or handle the user wallet.

## Blocked on Duan: Self mainnet document scan

- Mainnet Self registration needs Duan's real document, the Self app on his phone, and an NFC read of the document chip. Indonesia is Full Support in the Self country list, so this is a scheduling step, not an eligibility risk. Until it is done, mainnet mode verification works but no Tanda agent can pass it, because no Tanda agent has a human proof yet.
- The full flow is rehearsed without it: testnet mode with a mock passport (Self app, Generate Mock Document), and mock mode in the test suite, including the refusal paths.

## Blocked on wallet funding

- The payout leg after a settled order (Textile conversion broadcast, IDRX transfer, ERC-8004 reputation feedback) needs the funded operator wallet. Amounts from BUILD-PLAN.md: 10 CELO for gas and 6 USDT of principal in the operator wallet; gas actually burned across the whole event is expected at 1 to 3 CELO.

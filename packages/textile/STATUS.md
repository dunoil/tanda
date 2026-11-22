# Textile FX client: status

Date: 22 Nov 2026. Wallet state: the treasury taker wallet T (0x7D6bc7c0DF2d312e6137E78F99107db6Aff1d830) is funded with exactly 2 CELO and 0.10 USDT. Execution is implemented and live-attempted once; the conversion itself is blocked by the corridor's 1.00 USDT RFQ minimum at the 0.10 USDT proof size. Full record: EVIDENCE.md section 12 in the project folder.

## Done

- Quote client for the USDT to IDRX corridor in src/index.ts, on the RFQ API v2 at https://api.textilecredit.com/v2, chain 42220, token addresses from @tanda/money.
- Preview quotes (POST /rfq/preview) need no key and no proof, per the docs. Live preview verified 22 Nov 2026: 0.10 USDT priced at 1,834.27 IDRX (indicative 18,342.7 IDRX per USDT).
- Firm quotes (POST /rfq/request) follow the Authentication page pattern exactly: send unsigned first, sign the EIP-712 TakerControl challenge only on a 401 with reason proof_of_control_required, retry once. Quotes work with just a wallet; a partner API key is optional and only replaces the proof.
- Normalization runs through @tanda/money: the effective rate is computed in bigint and cross checked against convertUSDTToIDRX, and meetsFloorRate implements the desk floor rate rule from CONCEPT.md. The firm response envelope (data.quote nested amounts) is merged by unwrap, so real firm responses normalize the same way previews do.
- Execution (landed 22 Nov 2026, commit c2df400): submitQuote settles a firm quote, but only behind the explicit TEXTILE_EXECUTION_ENABLED opt-in (environment variable "true"/"1", or the executionEnabled client option); with the flag off it throws before touching anything, and a test proves nothing broadcasts. The enabled flow follows the documented RFQ v2 execution: expiresAt cutoff checks, allowance read against the quote reactor, approval broadcast (zero reset first when a nonzero allowance exists, USDT style) with receipts awaited before the swap, transactions.swap broadcast exactly as returned through the tagged wallet client from @tanda/wallet, hash reported to POST /v2/rfq/{id}/submit with the X-Rfq-Claim header. Every broadcast is simulated with the exact tagged bytes first and verifyTx checked after landing. requestExecutableQuote and parseExecutableQuote parse the documented envelope and hard-refuse any reactor other than the Celo LimitOrderReactor, a missing claim token, or missing swap calldata.
- Tests run fully offline: wire body, rate math (1.50 USDT at 16,000 IDRX per USDT gives 24,000 IDRX), floor pass and fail, no_quote handling, the 401 proof retry, TakerControl signature verification, the flag unit tests and flag-off throw, envelope parsing, wrong-reactor refusal, and stub-client submit flows (approve-then-swap, skip-approval, zero-reset, expiry refusal, suffix-carrying simulations). Textile suite: 16 tests; repo suite: 75 of 75, typecheck clean.

## Blocked on the corridor minimum, not on funding

- A live conversion at 0.10 USDT was attempted 22 Nov 2026 with Duan's go ahead and stopped at the firm quote: HTTP 400, "sellAmount is below the RFQ minimum (1000000 atomic units)". The USDT to IDRX corridor floor on mainnet is exactly 1.00 USDT (the documented default $1 floor). No approval or swap was broadcast. A conversion proof now needs a sell size of at least 1.00 USDT, which the real payout sizes in the traction plan (1 to 2 dollars per payout) already satisfy; the plan is to run the first conversion at the first genuine freelancer order's size, with Duan's go ahead, then the IDRX transfer to the freelancer.

## Not blocked

- Preview quotes against the live API, and the whole client test suite, work with zero funds and zero keys.

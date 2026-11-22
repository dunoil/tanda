# Textile FX client: status

Date: 22 Nov 2026. Wallet state: NOT funded. No conversion has been executed.

## Done

- Quote client for the USDT to IDRX corridor in src/index.ts, on the RFQ API v2 at https://api.textilecredit.com/v2, chain 42220, token addresses from @tanda/money.
- Preview quotes (POST /rfq/preview) need no key and no proof, per the docs.
- Firm quotes (POST /rfq/request) follow the Authentication page pattern exactly: send unsigned first, sign the EIP-712 TakerControl challenge only on a 401 with reason proof_of_control_required, retry once. Quotes work with just a wallet; a partner API key is optional and only replaces the proof.
- Normalization runs through @tanda/money: the effective rate is computed in bigint and cross checked against convertUSDTToIDRX, and meetsFloorRate implements the desk floor rate rule from CONCEPT.md.
- Tests run fully offline on mocked responses in the documented response shape: wire body, rate math (1.50 USDT at 16,000 IDRX per USDT gives 24,000 IDRX), floor pass and fail, no_quote handling, the 401 proof retry, and TakerControl signature verification.

## Blocked on wallet funding

- Executing a conversion: submitQuote throws by design in this prep build. Settlement needs a funded taker wallet (the API checks proof of funds on firm requests) and the tagged broadcast path in the payout worker. Budget from BUILD-PLAN.md: conversions of 1 to 2 dollars each for real payouts, 3 to 10 dollars total if all traction targets hit, plus under 0.01 dollars of gas per conversion class transaction.
- A live firm quote against mainnet also waits for funding, because the API checks that the taker wallet holds the sell token. Preview quotes do not check funds.

## Not blocked

- Preview quotes against the live API, and the whole client test suite, work with zero funds and zero keys.

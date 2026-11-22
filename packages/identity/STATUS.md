# ERC-8004 registration: status

Date: 22 Nov 2026. Wallet state: NOT funded. No mainnet transaction has been sent.

## Done

- Registration module in src/index.ts, following the Celo ERC-8004 docs flow exactly: publish the registration file without `registrations`, call `register(agentURI)`, read the agent id from the `Registered` event on the receipt (never the simulated return value), update the file, then `setAgentURI` if the URI changed.
- Registration file builder (`buildRegistrationFile`, `withRegistration`) with the EIP-155 registry reference for the canonical Celo mainnet Identity Registry, 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432.
- Dry run mode (`register.ts` script, default): builds and prints the exact tagged-path transaction from the agent wallet and sends nothing.
- Unit tests: calldata encoding, registration file shape, dry run sends nothing, agent id parsed from a fabricated `Registered` event, live path with injected fake clients.

## Blocked on wallet funding

- The live `register(agentURI)` send, the follow up `setAgentURI` send if the hosted file URI changes, and the parallel registration in the Self registry (0xaC3DF9ABf80d0F5c020C06B04Cced27763355944, done through the Self Agent ID flow, see the server Self module).
- Cost, from the budget in BUILD-PLAN.md: about 0.05 CELO of gas per registry write (a 250,000 gas class transaction at about 200 Gwei, CELO near 0.055 dollars), so both registries plus file updates stay well under 0.05 dollars total. The funding that unlocks this is part of the 10 CELO gas funding for the operator wallet in the plan budget.
- Funding is a human step for Duan: a transfer to 0xed328f847eF33f35148513DCEFB10069FcE53725.

## Not blocked

- Publishing the registration file itself (step 1) needs no funds: `register.ts --print-registration-file` prints the file to host.

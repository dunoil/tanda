# Tanda agent wallet

Public address only. The private key is not in this repo and never will be: it lives only in the local .env file (mode 600, gitignored).

- Agent wallet public address: 0xed328f847eF33f35148513DCEFB10069FcE53725
- Chain: Celo mainnet (42220)
- Attribution code: celo_f58da6359b7f
- Rule: keep this same wallet for the whole hackathon event, the Loops House score is tied to it.
- Role: the buyer and desk operator identity. This is the Self Agent ID agent (ID 207, mainnet) and the ERC-8004 agent (ID 10094). It signs orders and pays for them.

## Treasury wallet (desk payTo)

Public address only, same rule as above: the private key lives only in the local .env file (as TREASURY_PRIVATE_KEY, mode 600, gitignored) and is never committed or printed.

- Treasury wallet public address: 0x7D6bc7c0DF2d312e6137E78F99107db6Aff1d830
- Chain: Celo mainnet (42220)
- Created: 22 Nov 2026, fresh key.
- Role: the Tanda treasury, and the desk payTo for x402 orders (configured as SELLER_PAY_TO). Why a separate wallet: the Celo x402 facilitator refuses settlements where the payer and the payTo are the same address ("moves no value", proven on Celo Sepolia, see EVIDENCE.md section 9 in the project folder). The agent wallet therefore stays the buyer, and order payments land in this treasury wallet. The Loops House agent wallet of record remains the agent wallet above; this treasury address is the x402 PayTo to file on the submission.

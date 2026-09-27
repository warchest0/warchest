# Public whitepaper — corrections to incorporate (S0.4)

> To be applied to `warchest-public-whitepaper.pdf` at its next regeneration. Sources: `RESEARCH.md`, `DECISIONS.md`.

| § | Current text | Correction | Reason |
|---|---|---|---|
| 2.1 | "a pattern already validated in live production on Robinhood Chain by comparable projects" | "Several Uniswap v4 tax hooks are already deployed on Robinhood Chain and listed in the Uniswap hooklist. The WARCHEST hook will be audited before mainnet." | The Stakd reference is not equivalent (max 6%, not audited). We must not imply that any audit validation exists. |
| 2.1 | (missing) | Specify that the fee is **always taken in ETH**, and that it equals 10% of the gross ETH amount of the swap. | D3 |
| 2.2 | "the most recently acquired tokens are considered sold first" | Keep this text and name the mechanism (**LIFO**). Specify that a transfer between wallets counts as a sale for the sender. | D1 |
| 2.3 | "Voting power equals holding size multiplied by level" | "Voting weight is the sum, over each lot held, of amount × level of that lot, frozen at the daily snapshot." | D1, D2: each lot has its own level, and the snapshot prevents double voting. |
| 3.1 | "Positions close either automatically, through non-negotiable stop-loss rules" | Specify that stop-losses are **trigger orders placed on Hyperliquid** at the time of opening, and that they remain active even if the keeper is offline. | The vault on Robinhood Chain cannot enforce a stop on Hyperliquid. |
| 3.1 | "Realized profit is distributed automatically, in proportion to each holder's level" | Pending legal advice (D7). If distribution is kept: "pro rata to weight (amount × level)", only above the high-water mark. | Consistency with the vote, and regulatory risk. |
| 4 | "trading-only agent wallet with no withdrawal rights" | Add that the Hyperliquid account is held by a **multisig**, and that only the multisig can withdraw the funds. | D4: this is the real trust model. |
| 4 | (missing) | Specify that funds transit through the **USDG** stablecoin on Robinhood Chain, then through USDC on Hyperliquid, via the Across bridge, with fees of about 6 bp. | RESEARCH §3 |
| 5 | Roadmap | Add the external audit and the legal advice before mainnet. Realistic timeline: 14 to 16 weeks. | PLAN.md |

Reminder of the Robinhood Chain Terms of Service: **no use of the Robinhood brand** in communications related to the token issuance.

# Whitepaper public — corrections à intégrer (S0.4)

> À appliquer à `warchest-public-whitepaper.pdf` lors de sa prochaine régénération. Sources : `RESEARCH.md`, `DECISIONS.md`.

| § | Texte actuel | Correction | Raison |
|---|---|---|---|
| 2.1 | « a pattern already validated in live production on Robinhood Chain by comparable projects » | « Plusieurs hooks de taxe Uniswap v4 sont déjà déployés sur Robinhood Chain et référencés dans la hooklist Uniswap. Le hook WARCHEST sera audité avant le mainnet. » | La référence Stakd n'est pas équivalente (max 6 %, non audité). Il ne faut pas laisser entendre qu'il existe une validation d'audit. |
| 2.1 | (absent) | Préciser que la fee est **toujours prélevée en ETH**, et qu'elle vaut 10 % du montant ETH brut du swap. | D3 |
| 2.2 | « the most recently acquired tokens are considered sold first » | Conserver ce texte et nommer le mécanisme (**LIFO**). Préciser qu'un transfert entre wallets compte comme une vente pour l'émetteur. | D1 |
| 2.3 | « Voting power equals holding size multiplied by level » | « Le poids de vote est la somme, sur chaque lot détenu, de montant × level de ce lot, figée au snapshot quotidien. » | D1, D2 : chaque lot a son propre level, et le snapshot empêche le double vote. |
| 3.1 | « Positions close either automatically, through non-negotiable stop-loss rules » | Préciser que les stop-loss sont des **ordres trigger posés sur Hyperliquid** au moment de l'ouverture, et qu'ils restent actifs même si le keeper est hors ligne. | Le vault sur Robinhood Chain ne peut pas enforcer un stop sur Hyperliquid. |
| 3.1 | « Realized profit is distributed automatically, in proportion to each holder's level » | En attente de l'avis juridique (D7). Si la distribution est maintenue : « au prorata du poids (montant × level) », uniquement au-dessus du high-water mark. | Cohérence avec le vote, et risque réglementaire. |
| 4 | « trading-only agent wallet with no withdrawal rights » | Ajouter que le compte Hyperliquid est détenu par un **multisig**, et que seul le multisig peut retirer les fonds. | D4 : c'est le vrai modèle de confiance. |
| 4 | (absent) | Préciser que les fonds transitent par le stablecoin **USDG** sur Robinhood Chain, puis par l'USDC sur Hyperliquid, via le bridge Across, avec des frais d'environ 6 bp. | RESEARCH §3 |
| 5 | Roadmap | Ajouter l'audit externe et l'avis juridique avant le mainnet. Délai réaliste : 14 à 16 semaines. | PLAN.md |

Rappel des CGU Robinhood Chain : **aucun usage de la marque Robinhood** dans la communication liée à l'émission du token.

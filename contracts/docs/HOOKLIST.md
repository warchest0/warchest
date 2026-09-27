# Dossier hook allowlist Uniswap (brouillon, à soumettre après l'audit)

Référence : https://developers.uniswap.org/hook-allowlist — PR sur https://github.com/Uniswap/hooklist
Précédent comparable sur Robinhood Chain : TaxHook, PR #10290 (10 % en afterSwap, source vérifiée).

| Champ | Valeur |
|---|---|
| Chaîne | Robinhood Chain (4663) |
| Adresse du hook | _après le déploiement mainnet_ |
| Source vérifiée | Blockscout `robinhoodchain.blockscout.com`, obligatoire |
| Flags | beforeInitialize, beforeSwap, afterSwap, beforeSwapReturnsDelta, afterSwapReturnsDelta (`0x20CC`) |
| Comportement | Fee de 10 % du montant ETH brut, toujours en ETH natif, sur achat et vente. Stockée en claims ERC-6909, puis `flush()` permissionless vers un vault immutable. |
| Admin / upgrade | Aucun : pas d'owner, fee constante, pas de proxy |
| Pool autorisé | Un seul : ETH/WAR, initialisé par l'adresse `initializer` immutable |
| Audit | _rapport à joindre (S1.5 / S6.2)_ |
| Limitations | Un achat exactIn ou une vente exactOut dont le fill serait partiel **revert** (anti-surfacturation, voir HOOK.md) |

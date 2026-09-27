# WarchestDistributor (S3.4) — module optionnel (D7)

> **Décision juridique en attente (D7).** Le vault reçoit l'adresse du distributor dans son constructeur, sous forme **immutable**.
> - Avec `address(0)`, la distribution est **désactivée définitivement** pour ce déploiement.
> - Pour l'activer, il faut déployer le distributor **avant** le vault, puis appeler `dist.setVault(vault)`.

## Flux
1. `fund()` (permissionless) tire `vault.distributable()`, c'est-à-dire le profit réalisé au-dessus du high-water mark, quand aucune position n'est ouverte. Le montant est **mesuré** par variation de solde, pas déclaré.
2. L'indexer répartit chaque financement selon les poids du snapshot (Σ lot × level) et publie un arbre de **droits cumulés** `(account, cumulativeAmount)`, feuille séparée par `chainid` et adresse du contrat.
3. `proposeRoot(root, totalCumulative, treeHash)` : le root est en attente pendant `timelock`, et le guardian peut le révoquer. **Un root en attente ne peut pas être remplacé par l'updater.** C'est la correction du défaut de Morpho URD, où un updater compromis relance le délai à l'infini.
4. `acceptRoot()` est permissionless une fois le délai écoulé.
5. `claim(account, cumulative, proof)` verse `cumulative − claimed[account]` au compte. N'importe qui peut déclencher le versement.

## Bornes de sécurité
- `totalCumulative ≤ totalFunded`, et ne diminue jamais.
- `totalClaimed ≤ totalCumulative` du root actif. Un arbre sous-déclaré ne peut donc que bloquer les derniers claimers, jamais faire sortir plus que prévu.
- Le guardian ne peut **jamais** déplacer de fonds. Ses seuls pouvoirs sont `setVault` (une seule fois), `setUpdater`, `revokePendingRoot` et le transfert de son rôle en deux étapes.

## Tests
`test/WarchestDistributor.t.sol` : 13 tests branchés sur le **vrai** `WarchestVault`. Couverts :
- profit, perte, HWM ;
- timelock et révocation ;
- impossibilité de relancer le délai ;
- claims cumulés sur deux cycles ;
- preuves falsifiées ;
- arbre sous-déclaré ;
- guardian sans pouvoir sur les fonds.

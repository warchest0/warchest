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
- Le guardian ne peut **jamais** déplacer de fonds. Ses seuls pouvoirs sont `setVault` (une seule fois), `proposeUpdater` / `cancelUpdaterChange`, `revokePendingRoot` et le transfert de son rôle en deux étapes.

## Rotation de l'updater (revue de sécurité, constat haut, corrigé)
Avant : `setUpdater` était instantané. Le guardian seul pouvait se nommer updater, proposer un root qui lui versait tout le profit financé, et personne d'autre que lui ne pouvait révoquer ce root : après le timelock, `acceptRoot` et `claim` étaient permissionless. Violation directe de D9 (« le guardian ne déplace jamais de fonds »).

Maintenant, calqué sur `WarchestGovernance` :
- `proposeUpdater(next)` (guardian) émet `UpdaterChangeProposed(next, readyAt)` avec `readyAt = now + updaterDelay`, où **`updaterDelay = timelock + 3 jours`** (immutable, 4 jours avec le timelock recommandé de 1 jour).
- `cancelUpdaterChange()` (guardian) annule ; `applyUpdaterChange()` est **permissionless** une fois `readyAt` atteint. L'ancien updater garde son rôle pendant tout le préavis.
- Un root proposé par le nouvel updater attend encore son propre `timelock`.

Confiance résiduelle, documentée : après ce préavis public de ≥ 4 jours, puis le timelock du root, la paire guardian + updater peut encore mal répartir le profit **déjà financé** (jamais le principal, le vault ne cède que `distributable()`). L'attaque la plus rapide est donc annoncée on-chain pendant `updaterDelay + timelock ≥ 5 jours` (`UpdaterChangeProposed`, `UpdaterChanged`, `RootProposed` avec `treeHash`), ce que le vérificateur indépendant détecte et ce qui laisse le temps de contester le multisig. Aucune borne on-chain supplémentaire n'a été retenue : un plafond par compte ou par root n'est pas sain (le guardian peut fractionner sur des adresses qu'il contrôle, et une répartition légitime peut concentrer les droits sur un gros holder).

## Tests
`test/WarchestDistributor.t.sol` : 15 tests branchés sur le **vrai** `WarchestVault`, plus `test_regression_distributorGuardianCannotStealFundedProfit` dans `WarchestVaultReviewRegression.t.sol`. Couverts :
- profit, perte, HWM ;
- timelock et révocation ;
- impossibilité de relancer le délai ;
- claims cumulés sur deux cycles ;
- preuves falsifiées ;
- arbre sous-déclaré ;
- guardian sans pouvoir sur les fonds ni sur les roots ;
- rotation de l'updater : délai, annulation, application permissionless, événements, PoC du vol rejoué.

# WarchestGovernance

Contrat **séparé du vault**, qui ne détient **aucun fonds**. Il fait trois choses :
1. Stocker les roots merkle de poids, un par snapshot quotidien.
2. Compter les votes.
3. Exposer les décisions via `IWarchestDecisionSource`.

## Poids de vote (D1, D2)
- `poids(wallet) = Σ lot.montant × level(lot)`, avec un level de 0 à 10 et des lots LIFO, calculés off-chain par l'indexer.
- Feuille de l'arbre : `keccak256(bytes.concat(keccak256(abi.encode(chainid, governance, epoch, account, weight))))`, arbre à paires triées, standard OpenZeppelin. La feuille est séparée par chaîne et par contrat.
- Cycle de vie d'un root :
  - `submitWeightRoot(epoch, root, totalWeight, treeHash)` est réservé à l'`updater`.
  - `epoch` est un index de jour UTC, strictement croissant et au plus égal à l'index de demain.
  - `0 < totalWeight ≤ MAX_TOTAL_WEIGHT`, pour que le calcul du quorum ne puisse jamais déborder.
  - Révoquer la dernière epoch fait revenir `latestEpoch` à la précédente (liste chaînée `prevEpoch`), ce qui permet de la resoumettre.
  - Le root devient utilisable après `challengeWindow`. Pendant cette fenêtre, le `guardian` peut le révoquer (`revokeWeightRoot`).

## Rounds
| Type | Ouverture | Options |
|---|---|---|
| Direction | `startDirectionRound(epoch)`, permissionless | `assetIndex*2 + side` (Long = 0, Short = 1) sur la liste fermée d'actifs, **copiée au démarrage** |
| Close | `startCloseRound(epoch)`, permissionless si `vault.closeVoteAllowed(decisionId)` | 0 = garder, 1 = fermer |

- Le snapshot d'un round doit être **le plus récent utilisable** (`latestUsableEpoch()`) : ni en attente, ni révoqué, ni périmé. Personne ne peut donc choisir un snapshot plus ancien qui l'avantage.
- Il y a au plus un round actif par type. Un round Direction et un round Close peuvent tourner en parallèle.
- `vote(round, option, weight, proof)` : un vote par wallet et par round, avec le poids complet du snapshot. Un transfert de tokens après le snapshot ne change rien, ce qui rend le double vote impossible.

## Finalisation (`finalize`, permissionless après `endsAt`)
- Un round n'est **valide** que s'il n'a pas été annulé (voir ci-dessous) **et** qu'il est finalisé au plus tard `votingPeriod` après `endsAt`. Un round invalide retombe toujours sur la décision précédente.
- Quorum : `totalVoted × 10 000 ≥ quorumBps × totalWeight(snapshot)`.
- **Direction** : une **nouvelle** décision (id + 1) n'est créée que si le quorum est atteint **et** que l'option gagnante est unique (pas d'égalité).
  - Sinon, **la décision précédente reste en place avec le même id** (D8). Il n'y a pas de rouverture automatique : le vault exécute chaque id au plus une fois, donc une position stoppée ne se rouvre qu'après une nouvelle décision ayant atteint le quorum.
- **Close** : `isCloseRequested(decisionId)` passe à vrai si le quorum est atteint et que « fermer » l'emporte strictement.

## Rôles (D9)
- **`guardian`** (multisig) :
  - peut : `setPaused`, `cancelRound`, `revokeWeightRoot` (pendant la fenêtre de challenge), `proposeUpdater`, `setEligibleAssets` (pour les rounds futurs uniquement), `setVault` (une seule fois), transfert du rôle en deux étapes ;
  - une **pause annule tous les rounds en cours**, et `cancelRound` fait de même pour un round précis : un round annulé ne peut que retomber sur la décision précédente. Le guardian peut donc bloquer une décision, mais jamais la choisir ;
  - la rotation de l'updater est **différée** de `challengeWindow + votingPeriod + maxRootAge` (72 h avec les valeurs proposées). Elle est publique pendant tout ce délai, puis n'importe qui peut l'appliquer (`applyUpdaterChange`). Le guardian ne peut donc pas prendre la place de l'updater et falsifier les poids à l'intérieur d'un seul round ;
  - ne peut jamais : modifier un vote ou un tally, ni imposer une décision.
- **`updater`** (indexer) : ne peut que soumettre des roots.

## Paramètres immuables (`Params`)
`challengeWindow`, `votingPeriod`, `maxRootAge`, `quorumBps`.

Valeurs proposées : 6 h, 24 h, 48 h, 10 %.

## Tests
- `WarchestGovernanceRoots`, `WarchestGovernanceVoting`, `WarchestGovernanceDecisions` (dont les scénarios D8 avec `MockDecisionVault`).
- Invariants dans `invariant/GovernanceInvariant` :
  - Σ tallies = totalVoted ≤ poids total ;
  - ids de décision monotones ;
  - un seul round actif ;
  - aucun fonds détenu.

## Revue de sécurité (Fable, 2026-09-27)
Constats corrigés, chacun couvert par un test de régression dans `WarchestGovernanceHardening` :
- **Haute** : le guardian pouvait forcer une décision en choisissant le moment de la pause.
- **Haute** : le guardian pouvait prendre la place de l'updater et falsifier les poids.
- **Haute** : une epoch très lointaine bloquait définitivement les soumissions.
- **Moyenne** : un `totalWeight` nul, ou assez grand pour faire déborder le calcul du quorum, était accepté.
- **Moyenne** : on pouvait choisir un snapshot plus ancien et plus favorable.
- **Basse** : un round finalisé très en retard produisait quand même une décision.
- **Info** : la feuille n'était pas séparée par chaîne et par contrat.

Consignes de design transmises au vault :
- une clôture demandée est exécutée **sans condition** ;
- une décision remplacée par une plus récente impose de **fermer puis rouvrir** la position ;
- l'ancienneté d'une décision se juge sur `getRound(roundId).endsAt`.

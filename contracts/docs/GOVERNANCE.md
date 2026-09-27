# WarchestGovernance

Contrat **séparé du vault**, qui ne détient **aucun fonds**. Il fait trois choses :
1. Stocker les roots merkle de poids, un par snapshot quotidien.
2. Compter les votes.
3. Exposer les décisions via `IWarchestDecisionSource`.

## Poids de vote (D1, D2)
- `poids(wallet) = Σ lot.montant × level(lot)`, avec un level de 0 à 10 et des lots LIFO, calculés off-chain par l'indexer.
- Feuille de l'arbre : `keccak256(bytes.concat(keccak256(abi.encode(epoch, account, weight))))`, arbre à paires triées, standard OpenZeppelin.
- Cycle de vie d'un root :
  - `submitWeightRoot(epoch, root, totalWeight, treeHash)` est réservé à l'`updater`. Les epochs sont strictement croissantes, sauf pour resoumettre une epoch révoquée.
  - Le root devient utilisable après `challengeWindow`. Pendant cette fenêtre, le `guardian` peut le révoquer (`revokeWeightRoot`).

## Rounds
| Type | Ouverture | Options |
|---|---|---|
| Direction | `startDirectionRound(epoch)`, permissionless | `assetIndex*2 + side` (Long = 0, Short = 1) sur la liste fermée d'actifs, **copiée au démarrage** |
| Close | `startCloseRound(epoch)`, permissionless si `vault.closeVoteAllowed(decisionId)` | 0 = garder, 1 = fermer |

- Le snapshot d'un round doit être utilisable, dater de moins de `maxRootAge` après sa fenêtre de challenge, et **ne jamais être antérieur** à celui du round précédent (pas de cherry-picking d'un vieux snapshot).
- Il y a au plus un round actif par type. Un round Direction et un round Close peuvent tourner en parallèle.
- `vote(round, option, weight, proof)` : un vote par wallet et par round, avec le poids complet du snapshot. Un transfert de tokens après le snapshot ne change rien, ce qui rend le double vote impossible.

## Finalisation (`finalize`, permissionless après `endsAt`)
- Quorum : `totalVoted × 10 000 ≥ quorumBps × totalWeight(snapshot)`.
- **Direction** : une **nouvelle** décision (id + 1) n'est créée que si le quorum est atteint **et** que l'option gagnante est unique (pas d'égalité).
  - Sinon, **la décision précédente reste en place avec le même id** (D8). Il n'y a pas de rouverture automatique : le vault exécute chaque id au plus une fois, donc une position stoppée ne se rouvre qu'après une nouvelle décision ayant atteint le quorum.
- **Close** : `isCloseRequested(decisionId)` passe à vrai si le quorum est atteint et que « fermer » l'emporte strictement.

## Rôles (D9)
- **`guardian`** (multisig) :
  - peut : `setPaused`, `revokeWeightRoot` (pendant la fenêtre de challenge), `setUpdater`, `setEligibleAssets` (pour les rounds futurs uniquement), `setVault` (une seule fois), transfert du rôle en deux étapes ;
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

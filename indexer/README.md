# WARCHEST — indexer

Service off-chain (Node ≥ 24, TypeScript, viem, `node:sqlite`) qui :
1. **indexe** les `Transfer` du token jusqu'au bloc `finalized`, donc à l'abri des reorgs (S4.1) ;
2. calcule les **lots LIFO** et les **levels** par snapshot quotidien UTC (S4.2) ;
3. construit l'**arbre merkle des poids**, le publie et pousse le root dans `WarchestGovernance` (S4.3).

```bash
npm ci
npm test
```

## Notes Robinhood Chain (mesurées)
- `eth_getLogs` renvoie `blockTimestamp = 0x0`. Les timestamps sont donc récupérés bloc par bloc, en requêtes JSON-RPC groupées.
- Le tag `finalized` est environ 8 500 blocs (≈ 14 min) derrière la tête de chaîne.
- Débit live : 430 transferts USDG sur 300 blocs, indexés en ≈ 1,1 s.

## Commandes
Les commandes lisent leur configuration dans l'environnement (voir `src/config.ts`).

| Commande | Rôle |
|---|---|
| `npm run indexer sync` | Indexe les transferts finalisés |
| `npm run indexer snapshot [day]` | Écrit l'arbre du jour dans `data/trees/<day>.json` (par défaut, le dernier jour complet) |
| `npm run indexer publish [day]` | Construit l'arbre puis appelle `submitWeightRoot`. Réservé à l'**updater**, idempotent. |
| `npm run indexer verify [day]` | **Seconde instance indépendante** : recalcule l'arbre et le compare au root on-chain. Code de sortie 2 en cas d'écart ; il faut alors alerter le guardian, qui peut révoquer pendant la fenêtre de challenge. |
| `npm run indexer run` | Entrée cron quotidienne, après 00:15 UTC, pour que le jour précédent soit finalisé |

Variables d'environnement :
- obligatoires : `TOKEN`, `START_BLOCK`, `GOVERNANCE` ;
- optionnelles : `RPC_URL`, `CHAIN_ID`, `EXCLUDED` (adresses du vault, du hook et du distributor, séparées par des virgules), `DB_PATH`, `OUT_DIR`, `UPDATER_PRIVATE_KEY`.

Le PoolManager v4, le token et la gouvernance sont toujours exclus.

## Format de l'arbre
- Feuilles `(chainid, governance, epoch, account, weight)`, au format OpenZeppelin `StandardMerkleTree`. C'est bit pour bit la même chose que `WarchestGovernance.leaf`, et c'est vérifié par un test d'intégration sur anvil.
- `treeHash = keccak256(dump JSON canonique)` est publié on-chain avec le root.

## Montée en charge (S4.4, mesurée en local)
| Holders | Transferts | Snapshot | Arbre | Dump | Profondeur des preuves |
|---|---|---|---|---|---|
| 10 000 | 59 824 | 0,16 s | 1,9 s | — | 14 |
| 100 000 | 598 492 | 2,2 s | 19,3 s | 29,4 Mo (heap 396 Mo) | 17 |

Coût on-chain constant, quel que soit le nombre de holders : un `submitWeightRoot` par jour (≈ 44,6 k gas, soit ≈ 0,003 $). Voir RESEARCH §4.2.

Benchmark : `npm run bench [holders] [achats par holder]`.

## Distribution (module D7)
`src/distribution.ts` :
- `addDistribution` répartit chaque financement du distributor au prorata des poids du snapshot. Les parts sont arrondies à l'unité inférieure, donc la somme distribuée ne dépasse jamais le montant financé.
- `buildDistributionTree` produit l'arbre **cumulé**, avec des feuilles identiques à `WarchestDistributor.leaf`.

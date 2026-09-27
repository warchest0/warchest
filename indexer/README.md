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

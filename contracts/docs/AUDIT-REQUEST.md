# Demande d'audit — brouillon (S1.5)

**Cible** : Uniswap Foundation Security Fund, qui peut subventionner l'audit de hooks v4. Voir https://www.uniswapfoundation.org/blog/proactive-security-for-uniswap-v4-builders
**À envoyer par le porteur du projet.** Rien n'a été soumis automatiquement.

## Périmètre phase 1
| Fichier | Rôle |
|---|---|
| `src/WarchestHook.sol` | Hook de fee 10 % en ETH (≈ 260 lignes) |
| `src/WarchestToken.sol` | ERC20 pur (≈ 25 lignes) |
| `script/DeployWarchest.s.sol`, `script/DeployWarchestHook.s.sol`, `script/utils/HookMiner.sol` | Lancement |

La gouvernance et le vault feront l'objet d'une seconde vague, après S2 et S3.

## Points à faire regarder en priorité
1. Signes des `BeforeSwapDelta` et des retours `int128` dans les 4 cas achat/vente × exactIn/exactOut.
2. Formule `feeOnNet = ceil(net/9)` et arrondis (borne prouvée par fuzz : 0 ≤ fee − 10 %·brut < 1 wei).
3. Politique de revert sur `PartialFill`.
4. `flush()` permissionless : réentrance depuis le vault, et 1 wei conservé volontairement.
5. Restriction `beforeInitialize`.

## Tests
72+ tests :
- unitaires ;
- fuzz sur les 4 cas ;
- 7 invariants stateful ;
- tests fork sur le vrai PoolManager et l'UniversalRouter du mainnet 4663.

Mesures de gas dans `RESEARCH.md` §4.1.

# WARCHEST — contracts

Foundry. Dépendances en submodules (versions épinglées) :
- `v4-core` `d153b04` (source `src/` identique à la release npm 1.0.2 ; c'est la révision épinglée par `uniswap-hooks` v1.2.1, dont `BaseHook` importe `types/PoolOperation.sol`, absent du tag `v4.0.0`)
- `v4-periphery` `9969eec` (main, `V4Router`, `HookMiner` de référence)
- `openzeppelin-contracts` v5.7.0
- `uniswap-hooks` v1.2.1

```bash
git submodule update --init --recursive
cp .env.example .env   # RPC Robinhood Chain (fork tests)
forge test                                   # unitaires (PoolManager local) ; les tests fork sont sautés sans ROBINHOOD_RPC_URL
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*" -vv   # fork mainnet 4663, vrai PoolManager
```

| Contrat | Rôle |
|---|---|
| `WarchestToken` | ERC20 pur, supply fixe, **zéro taxe** |
| `WarchestHook` | Hook v4 : 10 % du brut ETH sur chaque swap, en claims ERC-6909, `flush()` permissionless vers le vault immuable |

## WarchestHook (S1.2 + S1.3) — conception détaillée dans [`docs/HOOK.md`](docs/HOOK.md)
- Pool unique ETH natif / WAR, initialisable **une seule fois** et **uniquement par l'adresse `initializer`** (immuable), qui doit appeler `PoolManager.initialize` directement.
- Fee = 10 % du brut ETH dans les 4 cas (achat/vente × exactIn/exactOut), arrondi au wei supérieur en faveur du vault (`|fee − 10 %| < 1 wei`).
- ETH spécifié (achat exactIn, vente exactOut) → prélevée en `beforeSwap` ; ETH non spécifié → en `afterSwap`. Un remplissage partiel d'un swap prélevé en `beforeSwap` revert (`PartialFill`).
- Livraison : mint de claims ERC-6909 au hook (aucun appel externe pendant le swap, un vault qui revert ne bloque pas le marché), puis `flush()` → `vault`. `flush()` laisse 1 wei de claims (slot non nul, économise ~17k gas au swap suivant).
- Aucun owner, aucun setter, rien d'upgradable.

Tests : `test/WarchestHook.t.sol` (unitaires, exactIn), `test/WarchestHookExactOut.t.sol` (exactOut, remplissages partiels, liquidité nulle, multi-ticks, montants extrêmes, fuzz des 4 cas), `test/WarchestHookRouter.t.sol` (`V4Router` v4-periphery, multi-hop, slippage), `test/invariant/` (invariants stateful : conservation des fees, 10 % ± 1 wei, deltas réglés, supply constante), `test/fork/` (vrai PoolManager, UniversalRouter + Permit2, script de déploiement).

## Déploiement (script prêt pour S1.4)
```bash
export POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951 WARCHEST_TOKEN=... WARCHEST_VAULT=... POOL_INITIALIZER=...
forge script script/DeployWarchestHook.s.sol --rpc-url robinhood_testnet --broadcast --verify
```
Le script mine un salt (`script/utils/HookMiner.sol`) et déploie via le CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` pour que l'adresse encode les flags `beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta | afterSwapReturnDelta` (`0x20CC`). Testé sur fork mainnet (`test/fork/`).

## Lancement complet (S1.4)
`script/DeployWarchest.s.sol` : token, hook, initialisation du pool et liquidité full-range, en un seul script (testnet et mainnet). Runbook : `docs/DEPLOY.md`. Dossiers : `docs/HOOKLIST.md`, `docs/AUDIT-REQUEST.md`.

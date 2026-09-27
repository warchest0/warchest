# WarchestHook — notes de conception

Hook Uniswap v4 (`contracts/src/WarchestHook.sol`) qui prélève **10 % du brut ETH** sur chaque swap du pool canonique
ETH natif / WARCHEST et l'achemine vers un vault immuable. Aucun owner, aucun setter, rien d'upgradable : tous les
paramètres sont `constant` ou `immutable`.

## 1. Pool et directions

- ETH natif = `address(0)` = `currency0`, WARCHEST = `currency1`.
- `zeroForOne == true` ⇔ **achat** (ETH entre, WAR sort) ; `false` ⇔ **vente**.
- `amountSpecified < 0` ⇔ exactIn ; `> 0` ⇔ exactOut.
- L'ETH est la devise *spécifiée* ssi `(amountSpecified < 0) == zeroForOne`.

## 2. Définition de la fee et où elle est prélevée

`fee = 10 % du brut ETH`, le brut étant l'ETH que l'acheteur débourse en tout, ou l'ETH que le pool verse au vendeur.

| Cas | Devise spécifiée | Prélèvement | Formule | Delta renvoyé |
|---|---|---|---|---|
| Achat exactIn | ETH | `beforeSwap` | user paie X ; `fee = ⌈X/10⌉` ; le pool reçoit `X − fee` | `BeforeSwapDelta(+fee, 0)` |
| Achat exactOut | WAR | `afterSwap` | le pool a besoin de P ; `fee = ⌈P/9⌉` ; user paie `P + fee` | `int128(+fee)` (non spécifié) |
| Vente exactIn | WAR | `afterSwap` | le pool verse G ; `fee = ⌈G/10⌉` ; user reçoit `G − fee` | `int128(+fee)` |
| Vente exactOut | ETH | `beforeSwap` | user veut X net ; le pool doit verser `X + fee`, `fee = ⌈X/9⌉` | `BeforeSwapDelta(+fee, 0)` |

`fee = P/9` (resp. `X/9`) équivaut exactement à `fee = 10 % × (P + fee)` : dans les 4 cas la fee est bien 10 % du
brut, ce qui corrige l'asymétrie mesurée dans le spike S0.1 (9,09 % du brut en vente exactOut).

Conventions de signe (v4-core `Hooks.sol`) : un delta **positif** renvoyé par le hook est **crédité au hook** et
**débité au swapper**. En `beforeSwap`, `amountToSwap = amountSpecified + delta` : pour un achat exactIn (`−X + fee`)
le pool swappe moins ; pour une vente exactOut (`X + fee`) le pool doit verser plus. Le hook renvoie donc toujours
`+fee`. Le PoolManager ajoute `fee` au delta du hook, que le hook règle immédiatement par un `mint` de claims.

## 3. Arrondi

Toutes les divisions arrondissent **au supérieur** (en faveur du vault). Bornes, valables dans les 4 cas :

- `0 ≤ ⌈G/10⌉ − G/10 < 1` ;
- avec `fee = ⌈N/9⌉` : `fee − (N + fee)/10 = (9·fee − N)/10 ∈ [0 ; 0,8]`.

Donc **`0 ≤ fee − 10 %·brut < 1 wei`** toujours, prouvé par fuzz (`testFuzz_*_feeWithinOneWeiOf10Percent`,
`testFuzz_allFourCases_feeBound`) et par l'invariant `invariant_feeIsTenPercentOfGross`.

Arrondir au supérieur ne casse jamais le swap : `⌈X/10⌉ ≤ X` pour `X ≥ 1`, donc le montant spécifié garde son signe
et `HookDeltaExceedsSwapAmount` est impossible. Cas limite documenté : pour un achat exactIn de moins de 10 wei,
la totalité est prise en fee et le pool ne swappe rien (Pool.swap avec un montant nul renvoie un delta nul).

## 4. Remplissages partiels (`sqrtPriceLimitX96`, liquidité insuffisante)

- **ETH spécifié (achat exactIn, vente exactOut)** : la fee est calculée en `beforeSwap` sur le montant *demandé*. Si
  le pool ne remplit qu'une partie, la fee dépasserait 10 % du réalisé, et en vente exactOut le swapper pourrait
  même finir par *payer* de l'ETH (`G' − fee < 0`). `afterSwap` recalcule donc le montant prévu (fonction pure des
  `params`, aucun stockage) et **revert `PartialFill(expected, actual)`** si le delta ETH du pool diffère.
  Concrètement : un achat exactIn ou une vente exactOut sur un pool sans liquidité, ou avec une limite de prix
  atteinte, revert. Les routeurs utilisent des limites extrêmes, donc cela n'apparaît que lorsque le pool ne peut pas
  servir la demande.
- **ETH non spécifié (achat exactOut, vente exactIn)** : la fee est calculée en `afterSwap` sur le réalisé. Le
  remplissage partiel est autorisé et facturé exactement 10 %.

Alternative écartée : rembourser la différence en `afterSwap`. Impossible, car `afterSwap` ne peut ajuster que le
delta de la devise *non spécifiée* (WAR dans ces cas), pas l'ETH.

## 5. Livraison des fees : claims ERC-6909 + `flush()`

À chaque swap, la fee est **mintée en claims ERC-6909** (id 0 = ETH) au hook, sans aucun appel externe. `flush()`,
**permissionless**, `unlock` le PoolManager, burn les claims et `take` l'ETH vers `vault`.

Pourquoi pas un `take` direct vers le vault pendant le swap :
1. **DoS** : un vault qui revert à la réception (pause du guardian, proxy cassé, `receive` absent) bloquerait tous
   les swaps du marché. Avec les claims, seule `flush()` échoue, les swaps continuent.
2. **Réentrance** : aucun contrat tiers n'est appelé pendant que le PoolManager est déverrouillé.
3. **Gas** : mint de claims ≈ SLOAD + SSTORE non-nul→non-nul + log, moins cher qu'un transfert natif vers une adresse
   froide. `flush()` est amorti sur N swaps.

`flush()` laisse **1 wei** de claims pour que le slot de balance ne repasse jamais à zéro (≈ 17 k gas économisés au
swap suivant). `pendingFees()` inclut ce wei. Réentrer `flush()` depuis le vault est inoffensif : le PoolManager est
déjà déverrouillé (`AlreadyUnlocked`) et les claims ont déjà été brûlés, donc l'appel interne revert.

Conséquence pour le vault (S3) : il doit **accepter l'ETH natif à tout moment**, depuis n'importe quel appelant.

## 6. Initialisation

`beforeInitialize` n'accepte que :
- `sender == initializer` (immuable) — empêche une initialisation front-run à un prix manipulé ;
- `currency0 == ETH` et `currency1 == token` ;
- LP fee statique (pas de `DYNAMIC_FEE_FLAG`) ;
- **une seule fois** : `poolId` est stocké, toute deuxième pool revert `PoolAlreadyInitialized`.

⚠️ `initializer` doit appeler `PoolManager.initialize` **directement**. Via le multicall du PositionManager, le
`sender` vu par le hook serait le PositionManager.

## 7. Adresse et déploiement

Flags encodés dans l'adresse : `beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta |
afterSwapReturnDelta` = `0x20CC`. `script/DeployWarchestHook.s.sol` mine le salt (`script/utils/HookMiner.sol`) et
déploie via le CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, présent sur Robinhood Chain. Testé en
fork mainnet (`test/fork/WarchestHookFork.t.sol`).

## 8. Compatibilité routeurs

Testé avec `PoolSwapTest` (v4-core), le `V4Router` de v4-periphery (single-hop, multi-hop exactIn/exactOut, slippage)
et l'**UniversalRouter officiel** `0x8876…0904` + Permit2 sur fork mainnet, pour les 4 cas.

- La fee est visible par la protection de slippage des routeurs (`amountOutMinimum`, `amountInMaximum`) et par le
  Quoter v4, qui simule le swap via le PoolManager, hook compris.
- Le `V4Router` épinglé revert `V4ExactOutputUnfilled` si la sortie réalisée est inférieure à la demande ; avec le
  hook, le delta renvoyé par `PoolManager.swap` est bien `X` net en vente exactOut, donc pas de faux positif.

## 9. Limites connues

- **Hook allowlist Uniswap** : un hook avec `*ReturnsDelta` n'est pas routé par l'app ni l'API Uniswap tant qu'il
  n'est pas validé sur la hook allowlist (source vérifiée obligatoire). Dossier à monter en S1.4 ; des `TaxHook` à
  10 % ont déjà été acceptés sur Robinhood Chain.
- Les swaps exactIn achat / exactOut vente **revertent** sur remplissage partiel (§4) au lieu d'être servis
  partiellement.
- Achats de moins de 10 wei : tout part en fee (§3).
- `flush()` dépend d'un appelant (keeper, ou n'importe qui). Sans appel, les fees restent en claims au hook, sans
  perte.
- Le hook n'a pas de `receive` : il ne peut détenir d'ETH. Les claims ERC-6909 peuvent lui être *offerts* par un
  tiers (`transfer`), ils finiront simplement au vault au prochain `flush()`.
- Un seul pool, LP fee statique choisie par l'initializer au déploiement (S1.4).

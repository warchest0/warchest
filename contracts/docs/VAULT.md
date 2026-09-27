# WarchestVault — notes de conception et modèle de confiance

Contrat `contracts/src/WarchestVault.sol`. Il **détient la trésorerie**. Il est séparé de `WarchestGovernance`, qui ne
détient rien et ne fait que publier des décisions (`IWarchestDecisionSource`). Aucun owner, aucun proxy, aucune
fonction qui envoie de l'ETH ou de l'USDG vers une adresse arbitraire : les seules sorties de fonds sont le pool de
conversion (S3.1) et, à partir de S3.2, le SpokePool Across vers un destinataire immuable.

## 1. Garde (S3.1)

- `receive()` accepte l'ETH natif **de n'importe qui, à tout moment, même en pause**, et ne revert jamais : le
  `flush()` du hook et `WETH.withdraw()` en dépendent. Il émet `EthReceived`.
- Pas de `fallback` : un appel avec des données inconnues revert, ce qui n'affecte pas un transfert simple.

## 2. Conversion ETH → USDG (S3.1)

### Venue
Pool Uniswap **v3** 0,01 % WETH/USDG `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` (TVL ≈ 19,6 M$, la plus profonde
mesurée dans `RESEARCH.md` §3.3). Vérifié on-chain le 2026-09-27 : `token0 = WETH 0x0Bd7…AD73`, `token1 = USDG
0x5fc5…d168` (6 décimales), `fee = 100`, factory `0x1f7d…2EfA` (la factory v3 officielle listée par Uniswap pour la
chaîne 4663).

Le vault appelle le pool **directement** (`swap` + `uniswapV3SwapCallback`) au lieu de passer par le `SwapRouter02`
officiel `0xcaf681a66d020601342297493863e78c959e5cb2` (vérifié on-chain, `factory()` et `WETH9()` cohérents) :
un contrat de confiance en moins, aucune approbation de token qui traîne, et le callback ne paie au pool que ce qu'il
réclame (`amount0Delta`), jamais plus que l'input exact. Le callback n'est accepté que si `msg.sender == pool` **et**
qu'un swap est en cours (flag transient), ce qui interdit à quiconque de siphonner du WETH que le vault détiendrait.

Le test fork `test_fork_convertOneEthMatchesQuoter` vérifie que le montant obtenu est **identique** à la quote du
`QuoterV2` officiel `0x33e8…a9E7` pour le même bloc.

### Garde-fou on-chain contre un keeper compromis
`convertEthToUsdg(amountIn, minOut)` est réservé au `keeper`, mais **un keeper volé ne peut pas brader l'ETH** :

1. **Plancher TWAP** : `minOut ≥ twapFloor(amountIn) = quote(TWAP_{30 min}) × (1 − maxSlippageBps)`. La TWAP vient
   de `pool.observe([1800, 0])` (tick moyen arithmétique, arrondi vers −∞ comme `OracleLibrary`). Le pool a une
   cardinalité d'observations de **10 809** (≈ 44 h d'historique à ~4 observations/min), vérifiée on-chain ; une
   fenêtre de 24 h répond sans `OLD`. Si l'historique venait à manquer, `observe` revert et la conversion est
   bloquée (fail-closed), rien n'est vendu.
2. **Sortie effective vérifiée** : le swap revert si l'USDG reçu est `< minOut` (mesuré par delta de balance, pas
   par la valeur renvoyée par le pool) et si le pool n'a pas consommé exactement `amountIn` (`PartialFill`).
3. **Plafond par appel** `maxConvertPerCall` et **cooldown** `convertCooldown` : le rythme est borné, le guardian
   a le temps de pauser.
4. **Sens unique** : il n'existe aucune fonction USDG → ETH. Un keeper malveillant ne peut donc pas faire des
   allers-retours pour accumuler du slippage.

Perte maximale prouvée (fuzz `testFuzz_maliciousKeeper_cannotSellBelowFloor`, invariant `invariant_neverSoldBelowFloor`,
fork `test_fork_sandwichedSpotRejected`) : **`maxSlippageBps` de l'ETH converti**, par rapport à la TWAP 30 min.
Valeurs recommandées : `twapWindow = 30 min`, `maxSlippageBps = 100` (1 %), `maxConvertPerCall = 50 ETH`,
`convertCooldown = 10 min`.

Limites connues :
- Si le prix spot s'écarte de plus de `maxSlippageBps` **sous** la TWAP (marché volatil), les conversions échouent
  jusqu'à ce que la TWAP rattrape : c'est voulu.
- Si le spot est **au-dessus** de la TWAP, le keeper peut fixer `minOut` au plancher et laisser un sandwicher
  capturer l'écart spot − plancher. La garantie est bien « jamais sous TWAP × (1 − s) », pas « au meilleur prix ».
- Une manipulation de la TWAP 30 min elle-même sur un pool de 19,6 M$ est coûteuse et ne rapporte rien au keeper
  au-delà de la borne ci-dessus.

## 3. NAV (S3.1)

`nav()` = **USDG en balance + ETH en balance × TWAP × (1 − maxSlippageBps)**, en USDG (6 décimales).

- L'ETH est valorisé au **plancher** qu'une conversion est garantie d'atteindre, jamais au spot : la NAV est
  pessimiste par construction, donc le plafond de 20 % (S3.2) calculé dessus l'est aussi.
- Le capital parti sur Hyperliquid **n'est pas** dans `nav()` (voir S3.3).
- `usdgLedger` = USDG comptabilisé par les opérations du vault (conversions, ordres…). `balance − ledger` = USDG
  arrivé de l'extérieur (retours de bridge, dons), que S3.3 attribue à la position en cours de clôture.

## 4. Rôles (S3.1)

| Rôle | Peut | Ne peut jamais |
|---|---|---|
| `keeper` (EOA bot, remplaçable) | `convertEthToUsdg` sous les bornes ci-dessus | envoyer des fonds ailleurs, changer un paramètre |
| `guardian` (multisig, D9) | `setPaused`, `setKeeper`, transfert du rôle en deux étapes | déplacer des fonds, changer le pool, les bornes, le destinataire |
| n'importe qui | envoyer de l'ETH | — |

Tous les paramètres sont `immutable`. La pause bloque les actions du keeper, jamais `receive()`.

## 5. Gas mesuré (fork mainnet, 2026-09-27)

| Fonction | Gas |
|---|---|
| `convertEthToUsdg(10 ETH)` à froid | 304 012 |

## 6. Tests
- `test/WarchestVaultConversion.t.sol` : construction, garde, conversion (chemins nominaux, tous les reverts, sandwich,
  fill partiel, oracle trop court), callback, maths de l'oracle (arrondi, branche haute), NAV, keeper malveillant
  (fuzz), rôles.
- `test/invariant/VaultInvariant.t.sol` : conservation de l'ETH, ledger = balance, jamais vendu sous le plancher,
  aucun fonds chez le keeper / guardian / attaquant.
- `test/fork/WarchestVaultFork.t.sol` : vrai pool, vrai WETH (proxy), vrai USDG, QuoterV2, dump de 2 000 ETH avant
  la conversion rejeté par le plancher.

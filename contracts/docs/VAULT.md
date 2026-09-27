# WarchestVault — notes de conception et modèle de confiance

Contrat `contracts/src/WarchestVault.sol`. Il **détient la trésorerie**. Il est séparé de `WarchestGovernance`, qui ne
détient rien et ne fait que publier des décisions (`IWarchestDecisionSource`). Aucun owner, aucun proxy, aucune
fonction qui envoie de l'ETH ou de l'USDG vers une adresse arbitraire : les seules sorties de fonds sont le pool de
conversion (S3.1) et le SpokePool Across vers un destinataire **immuable** (S3.2).

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
  pessimiste par construction, donc le plafond de 20 % calculé dessus l'est aussi.
- Le capital parti sur Hyperliquid **n'est pas** dans `nav()`. Comme un ordre ne peut être exécuté que sans position
  ouverte, le plafond est toujours mesuré sur les actifs **liquides** du vault, jamais sur une valeur déclarée.
- `usdgLedger` = USDG comptabilisé par les opérations du vault (conversions entrantes, ordres sortants).
  `balance − ledger` = USDG arrivé de l'extérieur (retours de bridge, remboursement d'un dépôt expiré, dons), que
  S3.3 attribue à la position en cours de clôture. Un ordre ne peut utiliser que l'USDG **comptabilisé**.

## 4. Exécution d'un ordre (S3.2)

`executeDecision(amount, outputAmount, quoteTimestamp, fillDeadline)`, réservé au keeper, hors pause :

| Contrôle | Règle |
|---|---|
| Décision | `governance.currentDecision()`, `id ≠ 0`, **`id > lastExecutedDecisionId`** (chaque id au plus une fois, D8) |
| Position | aucune position ouverte (**une seule à la fois**) |
| Fraîcheur | `block.timestamp ≤ governance.getRound(roundId).endsAt + maxDecisionAge` (une décision périmée doit être revotée : tout round quorate frappe un nouvel id) |
| Cap | `0 < amount ≤ nav() × capBps / 10 000`, et `capBps ≤ MAX_CAP_BPS = 2 000` **vérifié au déploiement** |
| Ledger | `amount ≤ usdgLedger` |
| Frais de bridge | `amount × (1 − maxBridgeFeeBps) ≤ outputAmount ≤ amount` (USDG et USDC ont 6 décimales) |
| Deadline | `fillDeadline > now` ; le SpokePool impose lui-même `quoteTimestamp ∈ [now − 1 h, now]` et `fillDeadline ≤ now + 6 h` |

Puis, dans cet ordre : `lastExecutedDecisionId = id`, position enregistrée (`decisionId, asset, side, capital,
openedAt, depositId`), `usdgLedger −= amount`, `forceApprove(spokePool, amount)`, **`deposit(bytes32,…)`** sur le
SpokePool, vérification que le SpokePool a tiré **exactement** `amount` et n'a plus d'allowance, événement
`OrderExecuted(decisionId, asset, side, capital, outputAmount, depositId, stopLossBps, leverage, takeProfitBps)`.

### Ce qui est figé dans le dépôt Across
- `depositor = vault` : un dépôt expiré (personne ne le remplit avant `fillDeadline`) est **remboursé au vault** sur
  Robinhood Chain ; S3.3 le voit comme un retour de capital.
- `recipient = bridgeRecipient` (compte Hyperliquid, multisig D4), `outputToken = USDC HyperEVM`,
  `destinationChainId = 999` : **immuables**, aucun setter.
- `exclusiveRelayer = 0`, `exclusivityParameter = 0` (pas de relayer exclusif, pas de sensibilité aux re-orgs),
  `message = ""` (le destinataire est un EOA, rien à exécuter).
- Étape 3 de D5 (HyperEVM → HyperCore) : faite par la clé HyperEVM du multisig, hors vault.

### ABI Across utilisée
`deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount,
uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32
fillDeadline, uint32 exclusivityParameter, bytes message)` — la version courante (non dépréciée) de
`across-protocol/contracts` `SpokePool.sol`. Vérifié le 2026-09-27 : sélecteur `0xad5425c6` présent dans le bytecode
de l'implémentation `0x1771…edd8` du proxy `0xD29C85F15DF544bA632C9E25829fd29d767d7978`, `depositQuoteTimeBuffer =
3 600`, `fillDeadlineBuffer = 21 600`, et **dépôt réel exécuté sur un fork mainnet** (`test_fork_executeDecision_realSpokePool`,
événement `FundsDeposited` conforme champ par champ). `depositV3(address,…)` existe aussi mais est marqué
« backward compatibility ». `enabledDepositRoutes` n'existe plus dans cette version (les routes ne sont plus gardées
on-chain).

### Paramètres de risque publiés
`stopLossBps`, `leverage`, `takeProfitBps` sont immuables, exposés par `riskParams()` et émis avec chaque ordre. Le
stop-loss **ne peut pas** être enforcé depuis Robinhood Chain (`RESEARCH.md` §2.5) : le keeper doit poser les
trigger orders sur Hyperliquid, et un moniteur indépendant doit vérifier qu'il l'a fait.

### `mustClose()`
Vrai quand une position est ouverte et que : la gouvernance a voté la clôture (`isCloseRequested`, **sans revérifier
le seuil de profit**), **ou** la gouvernance a frappé une décision plus récente (position **supplantée**, même si la
nouvelle décision a le même actif et le même sens : on ferme puis on rouvre, c'est plus simple et auditable), **ou**
le guardian a pausé le vault. Tant que la position n'est pas clôturée (S3.3), aucune nouvelle décision ne peut être
exécutée.

### Keeper malveillant : ce qu'il peut faire au pire
Prouvé par `testFuzz_execute_boundsHold`, `test_maliciousKeeper_atMostCapOncePerDecision`, l'invariant
`invariant_orderBounds` et le fork : quels que soient `amount`, `outputAmount`, `quoteTimestamp`, `fillDeadline`,
un appel revert **ou** envoie **≤ 20 % de la NAV liquide**, **une seule fois par décision de gouvernance**, vers le
**SpokePool pour le destinataire immuable**, avec **≤ `maxBridgeFeeBps`** de frais. Il ne peut ni changer le
destinataire, ni exécuter deux fois, ni ouvrir une seconde position, ni brader l'ETH (§2). Son levier restant est
**le timing** (exécuter au pire moment du marché) et ce qu'il fait *sur Hyperliquid* avec l'agent (voir
`RESEARCH.md` §2.3), hors de portée du vault.

## 5. Rôles (S3.1–S3.2)

| Rôle | Peut | Ne peut jamais |
|---|---|---|
| `keeper` (EOA bot, remplaçable) | `convertEthToUsdg`, `executeDecision` sous les bornes ci-dessus | envoyer des fonds ailleurs, changer un paramètre, rejouer une décision |
| `guardian` (multisig, D9) | `setPaused`, `setKeeper`, transfert du rôle en deux étapes | déplacer des fonds, changer le pool, le SpokePool, le destinataire, les caps |
| gouvernance | fournir la décision courante et la demande de clôture | appeler le vault (elle ne fait que le lire via `closeVoteAllowed`, S3.3) |
| n'importe qui | envoyer de l'ETH | — |

Tous les paramètres sont `immutable`. La pause bloque les actions du keeper, jamais `receive()`.

## 6. Mocks livrés
- `src/mocks/MockAcrossSpokePool.sol` : reproduit les contrôles du vrai `deposit` (fenêtre de `quoteTimestamp`,
  buffer de `fillDeadline`, règle d'exclusivité, tirage ERC20, `depositId`, événement) et garde les tokens ;
  `release()` permissionless simule un fill ou un remboursement (**testnet uniquement**, D6). Compilé en `via_ir`
  comme le vrai SpokePool (ABI à 12 paramètres).
- `test/mocks/MockUniswapV3Pool.sol` (TWAP et prix d'exécution découplés), `MockWETH`, `MockUSDG`,
  `MockDecisionSource`.

## 7. Gas mesuré (fork mainnet, 2026-09-27)

| Fonction | Gas |
|---|---|
| `convertEthToUsdg(10 ETH)` à froid | 296 974 – 304 012 |
| `executeDecision` (vrai SpokePool) à froid | 322 795 |

## 8. Tests
- `test/WarchestVaultConversion.t.sol` : construction, garde, conversion (chemins nominaux, tous les reverts, sandwich,
  fill partiel, oracle trop court), callback, maths de l'oracle (arrondi, branche haute), NAV, keeper malveillant
  (fuzz), rôles.
- `test/WarchestVaultExecute.t.sol` : bornes du constructeur (cap dur 20 %), chemin nominal, champs du dépôt Across,
  tous les reverts (vault et SpokePool), cap sur la NAV avec ETH au plancher, ledger, `mustClose`, fuzz des bornes,
  keeper malveillant.
- `test/WarchestVaultGovernance.t.sol` : **vraie `WarchestGovernance`** (snapshot, votes, finalisation) → exécution une
  seule fois, fallback de quorum (D8) sans réouverture, décision supplantée, péremption via `getRound().endsAt`.
- `test/invariant/VaultInvariant.t.sol` : conservation ETH et USDG (vault + SpokePool), ledger = balance, jamais vendu
  sous le plancher, cap et destinataire respectés à chaque ordre, une exécution par décision, position cohérente,
  aucun fonds chez keeper / guardian / attaquant / destinataire.
- `test/fork/WarchestVaultFork.t.sol` : vrai pool, vrai WETH (proxy), vrai USDG, QuoterV2, dump de 2 000 ETH avant
  la conversion rejeté par le plancher, **dépôt réel sur le SpokePool Across**, rejets de timestamps par le vrai
  SpokePool.

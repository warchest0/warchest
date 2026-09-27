# WarchestVault — notes de conception et modèle de confiance

Contrat `contracts/src/WarchestVault.sol`. Il **détient la trésorerie**. Il est séparé de `WarchestGovernance`, qui ne
détient rien et ne fait que publier des décisions (`IWarchestDecisionSource`). Aucun owner, aucun proxy, aucune
fonction qui envoie de l'ETH ou de l'USDG vers une adresse arbitraire : les seules sorties de fonds sont le pool de
conversion (S3.1), le SpokePool Across vers un destinataire **immuable** (S3.2) et, si un distributeur immuable a été
fixé au déploiement, le profit réalisé au-dessus du high-water mark (S3.3, désactivé tant que D7 est ouvert).

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

## 5. Rapports, clôture, PnL, high-water mark (S3.3)

### Rapports d'equity avec fenêtre de contestation
- `reportPosition(decisionId, equityUsd)` (keeper, hors pause) : valeur mark-to-market du compte Hyperliquid pour la
  position ouverte. Le rapport **ne compte qu'après `reportChallengeWindow`** (6 h recommandées) ; pendant cette
  fenêtre le guardian peut le révoquer (`revokeReport`). Un nouveau rapport remplace le rapport en attente et
  relance la fenêtre ; un rapport déjà mûr est conservé comme rapport « final » jusqu'à ce qu'un plus récent
  mûrisse. `finalizedEquity(decisionId)` renvoie l'equity qui compte (et si elle existe).
- Un rapport est **purement informatif** : il ne déplace jamais de fonds et ne change aucune balance. Son seul
  effet est d'autoriser un vote de clôture.
- `closeVoteAllowed(decisionId)` (lu par `WarchestGovernance.startCloseRound`, ne revert jamais) = position ouverte
  pour cet id **et** pas en cours de clôture **et** `!mustClose()` (pas supplantée, pas déjà votée, pas en pause)
  **et** equity finalisée `≥ capital × (1 + takeProfitBps)`.

### Clôture : le keeper déclare, la chaîne mesure
- Une fois `mustClose()` vrai (clôture votée — **inconditionnelle, sans revérifier le seuil** —, décision
  supplantée, ou pause), le keeper ferme sur Hyperliquid, le multisig signe le retour (D4, jamais le keeper), et le
  keeper appelle `reportClosed(decisionId)` (autorisé **même en pause** : rapatrier les fonds est toujours
  souhaitable).
- Le guardian dispose de `reportChallengeWindow` pour `revokeCloseReport` (par exemple si la position est encore
  ouverte sur Hyperliquid) ; la position redevient « ouverte ».
- `finalizeClose(decisionId)` (permissionless, après la fenêtre) mesure **on-chain** ce qui est revenu :
  `returned = usdg.balanceOf(vault) − usdgLedger`, c'est-à-dire tout l'USDG entré de l'extérieur depuis la dernière
  comptabilisation (fill du relayer Across sur le retour, remboursement d'un dépôt expiré, ou **rien du tout**).
  **Le keeper ne déclare jamais un montant** : il n'y a pas de paramètre pour ça. `pnl = returned − capital`,
  `cumulativePnl += pnl`, la position est effacée, une nouvelle décision peut s'exécuter.
- Chemins de perte : position liquidée ou stoppée avec rien qui revient → `returned = 0`, `pnl = −capital`, le
  vault continue avec sa NAV liquide restante (`test_finalizeClose_nothingReturned_vaultNotBricked`). Dépôt Across
  jamais rempli → le SpokePool rembourse le vault (depositor) → `pnl ≈ 0`.
- Retours en plusieurs morceaux (limite Across ≈ 278 k$/transfert, `RESEARCH.md` §3.2) : ce qui arrive après la
  finalisation est comptabilisé par `reconcile()` (keeper, position fermée uniquement) comme **retour tardif** de la
  dernière position (`LateReturn`, PnL à la hausse). Sans aucune position jamais fermée, c'est un `Donation`
  (principal, pas de PnL). `reconcile` ne peut qu'**augmenter** le ledger ; un keeper ne peut pas s'en servir pour
  sortir des fonds.

### Ce que le keeper peut faire de pire avec les rapports
- Rapporter une equity fictive → au pire un vote de clôture inutile, si le guardian ne révoque pas ; aucun fonds ne
  bouge.
- Déclarer la clôture alors que rien n'est revenu → après la fenêtre, `pnl = −capital` **comptable** (la position
  reste réelle sur Hyperliquid, contrôlée par le multisig) et une nouvelle décision devient exécutable : l'exposition
  par décision est inchangée (≤ 20 % de la NAV **liquide**, une fois par décision quorate), donc le rythme des
  décisions de gouvernance borne la sortie totale. Le guardian a une fenêtre pour révoquer, puis peut pauser.
- Spammer des rapports après révocation → la pause bloque `reportPosition`.
Tout cela est joué dans `WarchestVaultMaliciousKeeper.t.sol`.

### PnL réalisé, high-water mark et point d'ancrage de la distribution
- `cumulativePnl` (signé) = Σ (`returned − capital`) des positions fermées + retours tardifs. Les fees du hook
  (ETH) et les variations du prix de l'ETH sont du **principal**, jamais du PnL : la NAV n'est pas la base du HWM,
  précisément pour que des entrées de fees ne soient jamais « distribuées » comme des profits.
- `highWaterMark` = PnL cumulé **déjà distribué**. Il ne bouge que dans `pullDistributable` (+= montant), donc il est
  monotone (`invariant_pnlAndHighWaterMark`). Après une perte, tout doit être regagné avant qu'un centime ne soit à
  nouveau distribuable (`test_highWaterMark_lossMustBeRecoveredFirst`).
- `distributable()` = `max(0, cumulativePnl − highWaterMark)`, plafonné par `usdgLedger`, et **0 tant qu'une position
  est ouverte** (le résultat de la position en cours n'est pas réalisé).
- `pullDistributable(amount)` : uniquement `distributor`, immuable, fixé au déploiement. `address(0)` = distribution
  **définitivement désactivée** pour ce déploiement. C'est le seul point d'entrée du futur `WarchestDistributor`
  (S3.4, D7). ⚠ Conséquence : D7 (ou au moins l'adresse/le code du distributeur, prévisible par CREATE2) doit être
  tranché **avant** le déploiement mainnet du vault, sinon la trésorerie ne pourra jamais distribuer ; l'adresse du
  vault est elle-même immuable dans le hook.

### Pause
`setPaused(true)` bloque `convertEthToUsdg`, `executeDecision`, `reportPosition` et `pullDistributable`, et met
`mustClose()` à vrai : le keeper doit déboucler. `reportClosed`, `revokeCloseReport` et `finalizeClose` restent
possibles pour rapatrier et comptabiliser les fonds. `receive()` n'est jamais bloqué.

## 10. Risques résiduels (hors de portée du vault)
- **Hyperliquid** : le stop-loss est un trigger order posé par le keeper ; un keeper compromis peut ne pas le poser,
  trader contre une contrepartie complice (`RESEARCH.md` §2.3) ou sur-lever. Mitigations : agent trading-only à
  expiration courte, moniteur indépendant, multisig seul signataire des retours. Le vault ne voit que ce qui revient.
- **Multisig HL (D4)** : seul garant du retour des fonds ; sa clé HyperEVM fait l'étape HyperEVM → HyperCore.
- **Across** : contrat upgradable par Across ; une nouvelle ABI sans `deposit(bytes32,…)` bloquerait
  `executeDecision` (fail-closed, fonds intacts). Un dépôt non rempli est remboursé au vault. Un relayer peut au
  pire capter `maxBridgeFeeBps`.
- **Oracle TWAP** : une fenêtre de 30 min sur un pool de 19,6 M$ ; la borne est « pas pire que TWAP × 0,99 », pas
  « meilleur prix ». Si le pool perdait sa liquidité, les conversions échoueraient (fail-closed).
- **Gouvernance** : une décision quorate malveillante (capture par une baleine) reste une décision : le vault
  l'exécute dans la limite de 20 % de la NAV liquide, une fois.
- **Keeper honnête mais absent** : rien ne se passe ; les décisions expirent (`maxDecisionAge`) et doivent être
  revotées.
- **Distribution** : immuable et désactivée par défaut ; le choix D7 conditionne le déploiement (voir §5).

## 6. Rôles (S3.1–S3.3)

| Rôle | Peut | Ne peut jamais |
|---|---|---|
| `keeper` (EOA bot, remplaçable) | `convertEthToUsdg`, `executeDecision` sous les bornes ci-dessus ; `reportPosition`, `reportClosed`, `reconcile` (information et comptabilité, jamais de mouvement de fonds) | envoyer des fonds ailleurs, changer un paramètre, rejouer une décision, déclarer un montant revenu |
| `guardian` (multisig, D9) | `setPaused`, `setKeeper`, transfert du rôle en deux étapes, `revokeReport` et `revokeCloseReport` pendant la fenêtre de contestation | déplacer des fonds, changer le pool, le SpokePool, le destinataire, les caps, forcer une clôture comptable |
| `distributor` (immuable, S3.4) | `pullDistributable(amount ≤ distributable())` | toucher au principal ou à un profit sous le high-water mark |
| gouvernance | fournir la décision courante et la demande de clôture | appeler le vault (elle ne fait que le lire via `closeVoteAllowed`) |
| n'importe qui | envoyer de l'ETH, `finalizeClose` après la fenêtre | — |

Tous les paramètres sont `immutable`. La pause bloque les actions du keeper, jamais `receive()`.

## 7. Mocks livrés
- `src/mocks/MockAcrossSpokePool.sol` : reproduit les contrôles du vrai `deposit` (fenêtre de `quoteTimestamp`,
  buffer de `fillDeadline`, règle d'exclusivité, tirage ERC20, `depositId`, événement) et garde les tokens ;
  `release()` permissionless simule un fill ou un remboursement (**testnet uniquement**, D6). Compilé en `via_ir`
  comme le vrai SpokePool (ABI à 12 paramètres).
- `test/mocks/MockUniswapV3Pool.sol` (TWAP et prix d'exécution découplés), `MockWETH`, `MockUSDG`,
  `MockDecisionSource`.

## 8. Gas mesuré (fork mainnet, 2026-09-27)

| Fonction | Gas |
|---|---|
| `convertEthToUsdg(10 ETH)` à froid | 296 974 – 304 012 |
| `executeDecision` (vrai SpokePool) à froid | 322 795 |

## 9. Tests
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
- `test/WarchestVaultReports.t.sol` : rapports (fenêtre, remplacement, promotion, révocation), `closeVoteAllowed`
  (seuil exact, tous les cas « faux », fuzz « ne revert jamais »), clôture (profit, perte, rien revenu, remboursement
  Across, arrivées pendant la fenêtre, révocation), `reconcile` (retour tardif, don), high-water mark et
  `pullDistributable` (désactivé sans distributeur).
- `test/WarchestVaultMaliciousKeeper.t.sol` : scénario complet de clé volée et plafond des dégâts, rapports sans
  valeur, clôture anticipée, borne des frais de bridge, spam de rapports, **le guardian ne change jamais une
  balance**.
- `test/WarchestVaultGovernance.t.sol` : cycle complet avec la vraie gouvernance, y compris le vote de clôture
  (`startCloseRound` refusé tant que `closeVoteAllowed` est faux), `isCloseRequested` → `mustClose` → clôture →
  nouvelle décision sur un nouveau snapshot.
- `test/fork/WarchestVaultFork.t.sol` : vrai pool, vrai WETH (proxy), vrai USDG, QuoterV2, dump de 2 000 ETH avant
  la conversion rejeté par le plancher, **dépôt réel sur le SpokePool Across**, rejets de timestamps par le vrai
  SpokePool.
- Invariants (`VaultInvariant.t.sol`, handler complet : conversions, ordres, rapports, clôtures, retours simulés,
  réconciliations, révocations, pauses, retraits du distributeur, attaquants) : conservation ETH et USDG (vault +
  SpokePool + distributeur), jamais vendu sous le plancher, cap / destinataire / une exécution par décision, position
  cohérente, `cumulativePnl` = Σ retours mesurés − capitaux + retours tardifs, HWM = total distribué et monotone,
  `distributable ≤ ledger`, **le guardian ne bouge jamais une balance**, aucun fonds chez keeper / attaquant.

Piège de test noté : le compilateur met `block.timestamp` en cache dans une fonction (constant dans une vraie tx),
ce qui casse les `vm.warp` relatifs ; les tests du vault lisent `vm.getBlockTimestamp()`.

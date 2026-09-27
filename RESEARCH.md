# WARCHEST — RESEARCH.md

> Recherche vérifiée au **2026-09-27**. Légende : **[V]** vérifié (source ou appel live), **[I]** inférence, **[À MESURER]** exige une mesure réelle (spike S0), **[À TESTER]** exige un test sur testnet.
> Règle n°1 : aucune ligne de code de production tant que les points **[À MESURER]/[À TESTER]** ci-dessous ne sont pas fermés.

---

## 0. Verdict de faisabilité (résumé)

| Brique | Faisable ? | Commentaire |
|---|---|---|
| Token ERC20 + hook v4 fee 10% | **Oui** [V] | v4 officiel sur Robinhood Chain mainnet ; des TaxHooks à 10% existent déjà sur la chaîne. |
| Gouvernance levels × supply | **Oui, avec changement de design** | Il faut snapshotter le solde (pas `balance live × level`) → merkle root par epoch. |
| Vault (cap 20%, stop-loss) | **Oui, partiellement** | Le cap 20% est enforçable on-chain. Le **stop-loss ne l'est pas** depuis Robinhood Chain : il vit sur Hyperliquid (trigger orders). |
| Agent Hyperliquid sans retrait | **Oui** [V] | Enforcé par le schéma de signature du protocole. 2 actions ambiguës à tester (voir §2). |
| Bridge Across RH ↔ Hyperliquid | **Oui, mais pas comme décrit** | Pas d'USDC natif sur RH (USDG), pas de route directe vers HyperCore, **pas de testnet Across**, retour plafonné ~278k$/transfert. |
| E2E complet sur testnet | **Non tel quel** | Ni Uniswap v4 ni Across sur le testnet RH → v4 à déployer nous-mêmes, bridge simulé sur testnet. |
| Planning 6 semaines | **Non** | Réaliste : 12–16 semaines, dont 4–8 semaines d'audit. |
| Juridique | **Risque majeur** | Le partage de profits ressemble fortement à un contrat d'investissement (Howey) / OPC (UE). |

---

## 1. Robinhood Chain + Uniswap v4

### 1.1 La chaîne [V]
- Mainnet live depuis le **2026-07-01**, Arbitrum Orbit, gas en ETH. Chain ID **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `robinhoodchain.blockscout.com`. — https://docs.robinhood.com/chain/deploy-smart-contracts
- Testnet : chain ID **46630**, RPC `https://rpc.testnet.chain.robinhood.com` (tous deux confirmés par `eth_chainId`).
- Déploiement **permissionless**. Aucune politique KYC trouvée pour les lancements de tokens tiers, ce qui ne prouve pas qu'il n'y en a pas.
- Blocs **~100 ms** (mesuré : 10 000 blocs en 1 009 s). Séquenceur unique Robinhood en FCFS : le priority fee ne réordonne rien.
- Gas : ~0,025 gwei observé. Pic à 0,511 gwei le 3 sept. (tx médiane 0,006 $ → 0,20 $). — https://bitquery.io/investigations/robinhood-chain-gas-price-25x
- Particularités Orbit : `block.number` renvoie une estimation L1 (utiliser `ArbSys.arbBlockNumber()`), code max 96 KB. — https://docs.robinhood.com/chain/differences-from-ethereum/
- CGU (2026-02-10) : Robinhood peut **bloquer des adresses**, interdit l'activité illégale et **interdit l'usage de la marque Robinhood** pour une émission de token. — https://docs.robinhood.com/chain/terms-of-service

### 1.2 Uniswap v4 sur Robinhood Chain [V]
Annonce : https://blog.uniswap.org/robinhood-chain-is-live — adresses : https://developers.uniswap.org/docs/protocols/v4/deployments

| Contrat | Adresse (mainnet 4663) |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` (v2.1.2 : `0x204FAca1764B154221e35c0d20aBb3c525710498`) |
| Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

- ⚠️ **Aucun déploiement v4 sur le testnet 46630** (ni officiel ni tiers trouvé). On devra déployer v4-core nous-mêmes sur le testnet, et faire les tests d'intégration en **fork mainnet** Foundry. Le RPC public le permet, et Stakd le fait déjà.

### 1.3 ABI et comportement du hook [V]
Sources : `v4-core/src/libraries/Hooks.sol`, `IHooks.sol`, `types/BeforeSwapDelta.sol`, `LPFeeLibrary.sol`.

- **Permissions encodées dans les 14 bits bas de l'adresse du hook** :
  - `beforeSwap` = `1<<7`, `afterSwap` = `1<<6`, `beforeSwapReturnsDelta` = `1<<3`, `afterSwapReturnsDelta` = `1<<2`.
  - Adresse obtenue par minage de salt CREATE2 avec `HookMiner`, qui se trouve maintenant dans `Uniswap/v4-hooks-public` (et non plus dans v4-periphery).
- Signatures :
  - `beforeSwap(sender, key, params, hookData) returns (bytes4, BeforeSwapDelta, uint24)`
  - `afterSwap(sender, key, params, delta, hookData) returns (bytes4, int128)`
- `amountSpecified < 0` = exact input. Si le delta du hook inverse le signe du swap, celui-ci revert avec `HookDeltaExceedsSwapAmount`.
- **Toujours prélever la fee en ETH** (pattern Stakd) :
  - ETH = `address(0)` = **currency0**, donc `zeroForOne == true` = achat, `false` = vente.
  - Si l'ETH est la devise *spécifiée* → fee prélevée en `beforeSwap`.
  - Si l'ETH est la devise *non spécifiée* → fee prélevée en `afterSwap` (retour `int128`).
  - Encaissement via `poolManager.take` ou mint ERC-6909.
  - Il y a donc 4 cas à couvrir : achat/vente × exactIn/exactOut.
- L'alternative « dynamic LP fee » (`MAX_LP_FEE = 1_000_000`) **ne convient pas** : la fee va aux LP, pas au vault.
- ⚠️ **Routage** : un hook avec `*ReturnsDelta` n'est **pas routé par l'app ou l'API Uniswap** tant qu'il n'est pas validé sur la hook allowlist (source vérifiée obligatoire). — https://developers.uniswap.org/hook-allowlist
  - Précédents acceptés sur Robinhood Chain : `TaxHook` jusqu'à 10 % (https://github.com/Uniswap/hooklist/pull/10290), PeepsV4TaxHook, RiboV4TaxHook.
- Base de code recommandée : OpenZeppelin `uniswap-hooks` (`BaseHook`, `BaseHookFee`).

### 1.4 La référence « Stakd » : à corriger dans le whitepaper [V]
- Stakd existe (https://github.com/Stakdofficial/Stakd). Il prélève **1–5 % + 1 % créateur (max 6 %), pas 10 %**, envoie les fees sur des perps Lighter, et son README indique **« not independently audited »**.
- La référence la plus proche de notre design est `TaxHook` `0xa06cf6ca09f5a885941d4c4084cc39161b31c044` : 10 % en `afterSwap` sur la devise non spécifiée, envoyés à une trésorerie, source vérifiée.
- Autres références open source : Flaunch, Clanker v4, Doppler.
- → La phrase « pattern validé en production par Stakd » du whitepaper est **inexacte**. À reformuler.

---

## 2. Hyperliquid — wallet d'agent « trading only »

### 2.1 Enforcement [V]
Sources : https://hyperliquid.gitbook.io/hyperliquid-docs (signing, exchange-endpoint, builder-codes) et le SDK python `signing.py` / `exchange.py`.

- Le protocole utilise **deux schémas de signature distincts** :
  - **L1 actions** (domaine « Exchange », signables par un agent) : `order` (TP/SL inclus), `cancel`, `modify`, `batchModify`, `scheduleCancel`, `updateLeverage`, `updateIsolatedMargin`, `twapOrder`…
  - **User-signed actions** (EIP-712 « HyperliquidSignTransaction », **clé maître obligatoire**) : `withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `usdClassTransfer`, `approveAgent`, `approveBuilderFee`, `convertToMultiSigUser`.
- → **Le non-retrait est enforcé par Hyperliquid lui-même** via la vérification de signature, pas par le client. La doc le dit explicitement pour `approveBuilderFee` ; pour le reste, cela découle du schéma de signature.
- `agentSendAsset` est signable par un agent, mais la « destination doit égaler la source » : ce n'est qu'un mouvement interne.
- Limites des agents :
  - 1 agent non nommé + 3 nommés par compte, et 2 de plus par sub-account.
  - Expiration `valid_until` ≤ 180 jours.
  - Ne **jamais réutiliser une adresse d'agent**, car les nonces peuvent être rejoués après pruning.

### 2.2 Zones grises [À TESTER]
- Des sources tierces se contredisent sur la possibilité pour un agent de signer **`vaultTransfer`** et **`subAccountTransfer`** (le SDK les signe en `sign_l1_action`).
- → Test obligatoire sur le testnet HL : un agent tente `withdraw3`, `usdSend`, `vaultTransfer`, `subAccountTransfer` et `approveAgent`. On consigne les rejets ici, avec les réponses brutes de l'API.

### 2.3 Fuites de valeur possibles même sans retrait [V/I]
- **Vol par contrepartie complice** : un agent compromis peut trader à perte contre les ordres de l'attaquant sur un marché illiquide. La self-trade prevention ne bloque que la même adresse. **C'est le risque n°1.**
- Levier réglable jusqu'au max de l'actif, donc liquidation forcée possible. Slippage TWAP jusqu'à 3 %.
- Mitigations :
  - liste d'actifs fermée et liquide uniquement ;
  - marge isolée, levier fixe vérifié par un moniteur indépendant ;
  - `scheduleCancel` comme dead-man switch ;
  - rotation courte des agents ;
  - révocation par remplacement.

### 2.4 Qui détient la clé maître (le vrai point de confiance) [V]
- **Multisig natif HyperCore** : `convertToMultiSigUser`, jusqu'à 10 signataires plus un seuil. — https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/multi-sig
  - ⚠️ Le côté HyperEVM reste contrôlé par la clé d'origine, et CoreWriter ne fonctionne pas pour un compte multisig.
- Aucune allowlist ni délai de retrait natif : **la seule protection est le seuil du multisig**.
- Retraits vers Arbitrum : ~3–5 min, 1 $. Le bridge legacy est déprécié ; **CCTP est la voie préférée**.
- Sub-accounts (sans clé privée, tradés via `vaultAddress`) : sous un maître multisig, c'est la structure recommandée.
- Les vaults HL legacy (frais de création de 10k$, leader ≥ 5 %) sont déconseillés.
- Alternative avancée : **compte détenu par un contrat HyperEVM via CoreWriter**, qui peut ajouter un API wallet (action 9). Le retrait serait alors limité *par le code* à une destination fixe. Plus sûr en théorie, mais c'est un pattern récent qui demande un spike dédié.

### 2.5 Stop-loss [V]
- Les TP/SL sont des trigger orders **stockés on-chain sur Hyperliquid**, déclenchés sur le mark price, avec 10 % de slippage pour les ordres market. Ils restent actifs même si le keeper est offline (inférence tirée du fait que l'ordre est on-chain).
- ⚠️ Un TP/SL enfant n'est posé que si l'ordre parent est **entièrement rempli**.
- → Le WarchestVault (sur Robinhood Chain) **ne peut pas enforcer** le stop-loss. Il peut seulement stocker le paramètre, et le keeper doit le poser sur HL. Le whitepaper doit le dire.

### 2.6 Testnet HL [V]
- Faucet : `app.hyperliquid-testnet.xyz/drip`, 1 000 USDC mock, **l'adresse doit avoir déjà déposé sur mainnet**.
- Bridge testnet sur Arbitrum Sepolia : `0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89`.

---

## 3. Bridge Across Robinhood Chain ↔ Hyperliquid (appels API live, 2026-09-27)

### 3.1 Routes [V]
- Across est live sur Robinhood Chain depuis le 2026-07-06 (SpokePool `0xD29C85F15DF544bA632C9E25829fd29d767d7978`). — https://across.to/blog/bridge-to-robinhood-chain-with-across
- **Pas d'USDC Circle natif sur Robinhood Chain.** Le stablecoin routé est **USDG** (Paxos) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Routes vers Hyperliquid :
  - Route existante : `4663 USDG → 999 (HyperEVM) USDC`, et le retour inverse.
  - **Aucune route `4663 → 1337 (HyperCore)`** : l'API répond « No bridge routes found ».
  - **ETH/WETH n'a aucune route vers 999.**
- Route vers HyperCore validée *depuis Arbitrum* : `42161 USDC → 1337 USDC-PERPS`, 100k$ → 99 986 $ (1,4 bp, ~8 s, via CCTP).
- → Chemins candidats :
  - **A** : RH USDG → HyperEVM USDC (Across), puis HyperEVM → HyperCore (transfert vers l'adresse système `0x2000…`).
  - **B** : RH USDG → Arbitrum USDC (Across), puis Arbitrum → HyperCore USDC-PERPS (Across Swap API / CCTP). Ce chemin a besoin d'une adresse intermédiaire sur Arbitrum.

### 3.2 Coûts et délais mesurés (quotes live) [V]

| Sens | Montant | Coût | Délai estimé |
|---|---|---|---|
| RH USDG → HyperEVM USDC | 10k$ | ~6 bp (1 bp capital + 5 bp swap USDG→USDC) | ~2 s |
| RH → HyperEVM | 100k$ | ~6 bp | ~98 s |
| RH → HyperEVM | 500k$ | ~6 bp | ~900 s (au-dessus de l'instant max de 263k$) |
| HyperEVM → RH | 10k$ / 100k$ | 6 bp | 5 s / 27 s |
| HyperEVM → RH | 500k$ | **refusé** (`AMOUNT_TOO_HIGH`, max 278 572 $) | à découper |
| ETH RH → Arbitrum | — | — | max instant **~8,36 ETH** |

- Ces limites de liquidité sont un **instantané** : elles varient, et le keeper doit interroger `/limits` à chaque fois.
- ⚠️ **Across n'a pas de testnet pour Robinhood Chain ni pour Hyperliquid.** Le testnet Across ne couvre que Sepolia, Base, Arbitrum, OP, Amoy, Lens, Unichain et Solana Devnet.
- Ne pas utiliser le bridge canonique Orbit pour les retours : il impose **7 jours** de challenge.

### 3.3 Conséquences sur le design [I]
1. Le hook encaisse de l'ETH → le vault doit **swapper ETH → USDG** sur Robinhood Chain avant le bridge. La liquidité ETH/USDG du pool est à mesurer [À MESURER].
2. Le vault peut enforcer on-chain : montant ≤ 20 %, **recipient immuable**, appel direct au SpokePool Across. C'est une garantie réelle.
3. Le retour vers Robinhood exige une signature maître (`withdraw3` ou transfert EVM) : **il ne peut pas être automatisé par l'agent**. C'est voulu, et c'est une sécurité.
4. Pour l'E2E sur testnet, le bridge est **simulé**. La validation réelle du bridge se fera sur mainnet avec des petits montants, puis des montants de taille trésorerie.

---

## 4. Coût de gas réel [À MESURER — spike S0]

Aucun chiffre n'est estimé ici : les mesures seront faites en **fork mainnet 4663** (vrai PoolManager) avec `forge test --gas-report`, puis converties en $ au gas price observé (0,025 gwei, et au pic de 0,511 gwei).

| Mesure | Méthode | Résultat |
|---|---|---|
| Swap avec hook vs sans hook (achat/vente × exactIn/exactOut) | fork + gas-report | _à remplir_ |
| Push d'un merkle root de poids par epoch | fork | _à remplir_ |
| Vote avec preuve merkle (100k holders → profondeur ~17) | fork | _à remplir_ |
| (Pour comparaison) FIFO/LIFO on-chain, pire cas 500 petits achats | fork | _à remplir_ |
| (Pour comparaison) écriture de levels par wallet, batch de 1 000 / 10 000 | fork | _à remplir_ |

> Note : dans le plan technique, la logique de lots est **off-chain** (indexer). Le coût on-chain pertinent est donc celui des *mises à jour poussées* et des *votes*, pas celui du FIFO. On mesure quand même le FIFO on-chain pour justifier le choix.

---

## 5. Incohérences et trous dans les documents

1. **FIFO vs LIFO** : le whitepaper dit « les tokens acquis le plus récemment sont vendus en premier », ce qui est du **LIFO**. Le plan dit FIFO. Le LIFO correspond à l'intention (« couper une position ne détruit pas l'ancienneté du reste »).
2. **Poids par lot** : avec des lots, le poids est `Σ lot.montant × level(lot)`, pas `solde × level`. Un wallet n'a pas « un » level.
3. **Double vote** : `solde live × level` permet de voter, transférer, puis revoter (cf. Beanstalk, 182 M$). Il faut un snapshot du solde. → **Merkle root des poids par epoch** : coût O(1) on-chain, auditable, avec fenêtre de challenge (pattern Morpho URD).
4. **Transferts wallet → wallet** : ils sont à traiter comme une vente pour l'émetteur (LIFO) et un lot level 0 pour le receveur. Les adresses à exclure (PoolManager, vault, contrats) sont à définir.
5. **Quorum fallback** : « la décision précédente reste » est ambigu. Si la position précédente a été stoppée, faut-il la rouvrir ? À spécifier.
6. **Distribution** : le whitepaper dit « proportionnelle au level », alors que le vote est `taille × level`. Aucun contrat de distribution n'est prévu, ni de mécanisme de high-water mark on-chain, ni de NAV attestée. → À ajouter : un **Distributor** (merkle cumulatif) + un HWM dans le vault.
7. **Stop-loss « automatique » dans le vault** : impossible depuis Robinhood Chain (§2.5).
8. **Stakd** : mauvaise référence (§1.4).
9. **Testnet E2E** : impossible tel quel (§1.2 et §3.2).

---

## 6. Juridique et audit

- **SEC** :
  - Déclaration sur les meme coins (2025-02-27) : pas des securities *sauf* s'il y a une attente de profit fondée sur l'effort d'autrui.
  - Interprétation conjointe SEC/CFTC 2026-03-17 : c'est la transaction qui est analysée, et des « managerial efforts » continus rattachent le token à un contrat d'investissement.
  - Regulation Crypto Assets proposée le 2026-08-18 : son safe harbor exige des efforts « complétés », ce qui ne sera jamais le cas ici.
  - Exposition CFTC possible (commodity pool, puisque le pool trade des dérivés à levier).
  - → **WARCHEST (trésorerie commune + keeper actif + distribution de profits) coche Howey.**
- **UE** : les guidelines ESMA 2025 font d'un token qui donne une part des rendements d'un portefeuille géré un **OPC (AIFMD)** ou une **valeur mobilière (MiFID II)**.
- Robinhood peut bloquer des adresses (CGU).
- → **Avis juridique avant mainnet.** Options : géo-blocage US/UE, ou remplacer la distribution par du buyback & burn (argument plus faible sous Howey, mais pas nul).
- **Audit** :
  - Budget ~60–150 k$ et 4–8 semaines, fix-review compris (référence de prix Sherlock 2026).
  - **Uniswap Foundation Security Fund** : subventionne des audits de hooks v4, avec 22+ auditeurs agréés. À solliciter.
  - Le keeper et le bridge ne sont pas couverts par un audit Solidity.
- **Précédents** :
  - JELLY/HLP (mars 2025) : risque de venue sur Hyperliquid.
  - Mango (2022) : une gouvernance peut ratifier un vol.
  - Compound Prop 289 : capture par une baleine.
  - ai16z : un token de « fonds » déclaré mort.

---

## 7. Checklist pré-mainnet (état)

| Item du plan technique | État |
|---|---|
| Hook : direction achat/vente dans tous les états de pool | [À TESTER] fork mainnet + testnet (v4 auto-déployé) |
| Gas FIFO pire cas | [À MESURER] — sans objet si le calcul reste off-chain (§4) |
| Batches indexer → gouvernance à l'échelle | [À MESURER] → merkle root (O(1)) |
| Agent HL sans retrait enforcé par le protocole | **[V] confirmé**. 2 actions [À TESTER] |
| Across : coût et délai sur montants trésorerie | **[V] quotes live** (§3.2). Transfert réel [À TESTER] sur mainnet, petits montants |
| E2E complet sur testnet | Possible **avec bridge simulé** uniquement |
| Fallback de quorum | À spécifier (§5.5), puis à tester |

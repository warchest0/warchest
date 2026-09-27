# WARCHEST — Décisions d'architecture

> Tranchées le 2026-09-27 à partir de `RESEARCH.md`, par délégation du porteur de projet (recommandations de `PLAN.md`).
> Statut : **ACTÉ** = on build dessus · **PROVISOIRE** = on build dessus, à confirmer par une mesure · **OUVERT** = bloqué par un tiers (juridique, argent réel).

## D1 — Lots : LIFO — ACTÉ
Une vente consomme d'abord les tokens acquis le plus récemment, conformément au whitepaper §2.2. Le plan technique disait « FIFO » : c'est une coquille.
Un transfert wallet → wallet compte comme une vente LIFO côté émetteur et crée un nouveau lot de level 0 côté receveur.

## D2 — Poids de vote : merkle root par epoch — ACTÉ
- L'indexer calcule `weight(wallet) = Σ lot.amount × level(lot)`, avec un level de 0 à 10.
- Il construit un arbre merkle `(epoch, wallet, weight)`, publie l'arbre et le script, puis pousse **uniquement le root** via `submitWeightRoot`.
- Le root devient votable après une **fenêtre de challenge** pendant laquelle le guardian peut le révoquer.
- Chaque votant fournit sa preuve. Cela élimine le double vote par transfert, puisque le poids est figé au snapshot.
- On ne stocke aucun level par wallet on-chain.

## D3 — Fee toujours prélevée en ETH — ACTÉ
- ETH natif = `currency0`, donc `zeroForOne` = achat.
- Si l'ETH est la devise spécifiée, le prélèvement se fait en `beforeSwap` ; si elle est non spécifiée, en `afterSwap`.
- La fee est de 10 %, envoyée à un vault immuable.
- Pas de fee sur l'ajout ou le retrait de liquidité, ni sur `transfer`.

## D4 — Garde des fonds Hyperliquid : multisig natif HL + sub-account + agent — ACTÉ (phase 1)
- Compte maître converti via `convertToMultiSigUser` (seuil ≥ 2/3).
- Le trading se fait dans un sub-account, via un agent nommé avec expiration ≤ 30 jours et rotation.
- **Aucun builder fee n'est approuvé.**
- Le retour des fonds est signé par le multisig, jamais par le keeper.
- L'option d'un compte détenu par un contrat HyperEVM via CoreWriter est reportée en phase 2.

## D5 — Route de bridge — PROVISOIRE
Aller :
1. Le vault swappe ETH → USDG sur Robinhood Chain.
2. Across `4663 USDG → 999 USDC`, avec recipient = adresse du compte HL (immuable dans le vault).
3. Transfert HyperEVM → HyperCore vers l'adresse système.

Retour : `withdraw3` ou Across `999 → 4663`, découpé selon `/limits`.

À confirmer par S0.3 (petit transfert réel sur mainnet, en attente de l'accord et des fonds du porteur).

## D6 — E2E testnet avec bridge simulé — ACTÉ
Across n'existe ni sur le testnet Robinhood ni sur le testnet Hyperliquid. Le plan d'E2E est donc :
- Sur le testnet Robinhood : le v4 officiel (mêmes adresses que le mainnet) et un `MockAcrossSpokePool`.
- Sur le testnet Hyperliquid : trading réel.
- Puis sur mainnet : petits montants, puis montants de taille trésorerie, avant toute trésorerie réelle.

## D7 — Distribution des profits — OUVERT (juridique)
- Le `WarchestDistributor` (merkle cumulatif, pattern Morpho URD) est construit comme un **module séparé désactivé par défaut**.
- L'alternative buyback & burn reste possible sans toucher gouvernance ni vault.
- La décision finale attend l'avis juridique.

## D8 — Fallback de quorum — ACTÉ
- Si le quorum n'est pas atteint, la **direction** et l'**actif** précédents restent la décision courante.
- Une position fermée par stop-loss **n'est jamais rouverte automatiquement** : il faut une nouvelle décision ayant atteint le quorum.
- S'il n'existe aucune décision précédente, on ne fait rien.

## D9 — Guardian multisig — ACTÉ
Le guardian peut :
- pauser le vault et le keeper ;
- révoquer un root de poids pendant sa fenêtre de challenge ;
- révoquer un rapport keeper pendant sa fenêtre.

Il **ne peut jamais** déplacer de fonds ni changer le recipient du bridge.

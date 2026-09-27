# WARCHEST — Plan de build en slices

> Basé sur `RESEARCH.md` (2026-09-27). L'ordre des branches respecte strictement `instructions` : token-hook → governance → vault → indexer → keeper.
> Une slice = une PR livrable et testée. Colonne **Modèle** : 🟢 Opus suffit · 🔁 **basculer sur Fable** (slice où une erreur coûte de l'argent réel ou crée une faille de sécurité).

---

## Décisions (tranchées → voir `DECISIONS.md`)

| # | Décision | Recommandation |
|---|---|---|
| D1 | FIFO ou LIFO pour les lots ? | **LIFO**, comme dans le whitepaper : on vend d'abord les tokens les plus récents. |
| D2 | Comment la gouvernance reçoit-elle les poids ? | Un **merkle root des poids par epoch** + une fenêtre de challenge, à la place d'écritures de levels par wallet. |
| D3 | En quelle devise prélever la fee ? | **Toujours en ETH.** |
| D4 | Qui détient les fonds sur Hyperliquid ? | Phase 1 : **multisig natif HL** + sub-account + agent. Le compte contrat HyperEVM (CoreWriter) est à étudier plus tard. |
| D5 | Quelle route de bridge ? | Chemin A (RH USDG → HyperEVM → HyperCore) ou chemin B (via Arbitrum) : **tranché par le spike S0.3**. |
| D6 | Comment faire l'E2E sur testnet sans Across testnet ? | Bridge **simulé** sur testnet, puis validation mainnet avec de petits montants, puis des montants de taille trésorerie. Cela assouplit la contrainte « E2E testnet » : c'est à ton choix. |
| D7 | Que faire des profits ? | Distribution merkle (risque juridique) ou buyback & burn. **Avis juridique d'abord.** |
| D8 | Que se passe-t-il si le quorum n'est pas atteint ? | Garder la *direction* précédente, mais **ne jamais rouvrir automatiquement** une position stoppée. |
| D9 | Qui peut pauser le système ? | Un **guardian multisig** pouvant pauser le vault et le keeper. Il ne peut jamais déplacer de fonds. |

---

## Slice 0 — Recherche mesurée (branche `research/spikes`, code jetable, hors prod)
Objectif : fermer tous les [À MESURER]/[À TESTER] de RESEARCH.md. **Aucun code de prod tant que S0 n'est pas terminé.**

| Slice | Contenu | Livrable | Modèle |
|---|---|---|---|
| S0.1 | Foundry en fork mainnet 4663 avec un hook fee minimal (spike). Gas des 4 cas swap, du push de root, d'un vote avec preuve et d'un LIFO on-chain au pire cas. | Table §4 de RESEARCH.md remplie | 🟢 |
| S0.2 | Script sur le testnet HL : un agent tente `withdraw3`, `usdSend`, `vaultTransfer`, `subAccountTransfer` et `approveAgent`. On logge les rejets bruts. | §2.2 fermé, avec preuves | 🔁 Fable (conclusion de sécurité) |
| S0.3 | Transfert réel sur mainnet, petits montants (~50–100 $), RH USDG → HyperEVM → HyperCore **et** via Arbitrum, puis retour. On mesure délai, coût, étapes manuelles. On mesure aussi la liquidité ETH→USDG sur RH. | D5 tranché | 🟢 (avec ton OK : c'est du vrai argent) |
| S0.4 | Mise à jour du whitepaper : Stakd, LIFO, stop-loss sur HL, bridge USDG. | PR doc | 🟢 |

---

## Branche 1 — `feat/token-hook`
| Slice | Contenu | Critère de fin | Modèle |
|---|---|---|---|
| S1.1 | Scaffold Foundry + CI (fmt, test, slither) + `WarchestToken.sol` : ERC20 OZ pur, supply fixe, **aucune** logique de fee. | Tests : un transfer ne coûte rien, pas de hook dans le token | 🟢 |
| S1.2 | `WarchestHook.sol` (OZ `BaseHook`), cas **exactIn** achat/vente : 10 % en ETH, `take` vers un vault immuable, `beforeInitialize` qui n'autorise que le pool TOKEN/ETH. Script de déploiement avec HookMiner. | Tests en fork mainnet, vrai PoolManager | 🔁 **Fable** |
| S1.3 | Cas **exactOut**, swaps partiels (`sqrtPriceLimit`), liquidité nulle, franchissement de ticks, fuzz et invariants (fee = 10 % ± 1 wei, jamais de delta non réglé), add/remove liquidity non taxés. | Suite d'invariants verte | 🔁 **Fable** |
| S1.4 | Déploiement testnet 46630 : v4-core déployé par nous + token + hook + pool. Vérification Blockscout. Dossier hooklist Uniswap. | Swap réel sur testnet, gas-report | 🟢 |
| S1.5 | Pré-audit : demande au UF Security Fund, freeze du code. | Dossier envoyé | 🟢 |

## Branche 2 — `feat/governance-levels` (vault mocké, zéro dépendance)
| Slice | Contenu | Critère de fin | Modèle |
|---|---|---|---|
| S2.1 | Epochs + `submitWeightRoot(epoch, root)` par l'updater, fenêtre de challenge, révocation par le guardian. | Tests de rôles et de timing | 🟢 |
| S2.2 | Propositions avec liste fermée d'actifs × direction. `vote(epoch, choice, weight, proof)`, un vote par wallet par epoch, tally, quorum. | Tests merkle + tentative de double vote | 🟢 |
| S2.3 | Fallback de quorum (D8), vote de clôture au-dessus du seuil de profit, décision exposée au vault (`IWarchestDecision`) + MockVault. | 100 % des branches couvertes, invariants | 🟢 (revue 🔁 Fable conseillée sur S2.2–S2.3) |

## Branche 3 — `feat/treasury-vault` (keeper mocké)
| Slice | Contenu | Critère de fin | Modèle |
|---|---|---|---|
| S3.1 | Réception de l'ETH du hook, swap ETH→USDG avec slippage borné, comptabilité de NAV locale. | Tests en fork | 🟢 |
| S3.2 | `executeOrder()` : lit la décision de gouvernance, **cap dur 20 %**, cooldown, dépôt Across avec **recipient immuable**, rôle keeper limité. | Invariant : le vault ne peut jamais envoyer ailleurs ni plus de 20 % | 🔁 **Fable** |
| S3.3 | Rapports du keeper (open, close, PnL) avec délai et contestation, paramètres de stop-loss publiés (enforcés sur HL), high-water mark, pause par le guardian. | Tests avec MockKeeper, y compris un keeper malveillant | 🔁 **Fable** |
| S3.4 | `WarchestDistributor.sol` séparé : merkle cumulatif façon Morpho URD, alimenté seulement au-dessus du HWM. **Dépend de D7.** | Tests de claims | 🟢 |
| S3.5 | Câblage gouvernance ↔ vault sur testnet. | Cycle vote → ordre avec keeper mocké | 🟢 |

## Branche 4 — `feat/indexer` (TypeScript ou Python)
| Slice | Contenu | Critère de fin | Modèle |
|---|---|---|---|
| S4.1 | Ingestion des `Transfer` (RPC/Blockscout), gestion des reorgs et de la finalité, blocs à 100 ms. | Rejoue tout l'historique testnet de façon déterministe | 🟢 |
| S4.2 | Modèle de lots **LIFO**, snapshot quotidien, levels 1–10 par lot, exclusions (PoolManager, vault, contrats). | Tests unitaires sur des scénarios du whitepaper | 🟢 |
| S4.3 | Arbre merkle déterministe, publication de l'arbre et du script, push du root, 2ᵉ instance de vérification indépendante. | Deux runs donnent le même root | 🟢 |
| S4.4 | Test d'échelle 10k / 100k holders synthétiques, coût du push, alerting. | Chiffres ajoutés à RESEARCH.md | 🟢 |

## Branche 5 — `feat/keeper-hyperliquid` (en dernier, risque maximal)
| Slice | Contenu | Critère de fin | Modèle |
|---|---|---|---|
| S5.1 | Mode lecture seule : lit la gouvernance, le vault, le compte HL et les limites Across. Dry-run qui logge les actions prévues. | Tourne 48 h sans erreur | 🟢 |
| S5.2 | Trading sur le testnet HL via l'agent : marge isolée, levier fixe, TP/SL posés **après** le fill, `scheduleCancel`, rotation d'agents, moniteur indépendant (levier, actifs autorisés). | Ouverture/fermeture + stop déclenché sur testnet | 🔁 **Fable** |
| S5.3 | Module bridge : dépôts Across, suivi, retry, découpage au-delà des `/limits`, fillDeadline. Simulé sur testnet. | Tests + transferts mainnet de petits montants | 🔁 **Fable** |
| S5.4 | Retour des fonds (signé par le multisig, D4), rapport au vault, kill switch, alertes. | Runbook incident écrit | 🔁 **Fable** |
| S5.5 | **E2E** : vote → quorum → ordre vault → bridge → position HL → close → retour → distribution. Sur testnet avec bridge simulé, puis sur mainnet avec un cap trésorerie minuscule. | Checklist §7 de RESEARCH.md entièrement verte | 🔁 **Fable** |

## Fin
| Slice | Contenu | Modèle |
|---|---|---|
| S6.1 | Revue de sécurité complète pré-audit (tous les contrats + keeper) | 🔁 **Fable** |
| S6.2 | Audit externe + corrections | 🔁 Fable pour les fixes |
| S6.3 | Mainnet, cap trésorerie bas, monitoring | 🟢 |

---

## Quand basculer sur Fable (résumé)
Basculer (`/model`) **au début** de ces slices, puis revenir à Opus :
- **S0.2** : c'est la conclusion de sécurité sur les permissions de l'agent.
- **S1.2, S1.3** : comptabilité des deltas du hook. Un bug ici vole ou bloque des fonds à chaque swap.
- **S3.2, S3.3** : flux de fonds du vault et confiance accordée au keeper.
- **S5.2 à S5.5** : keeper, bridge et capital réel.
- **S6.1** : revue globale avant audit.

Tout le reste (scaffold, gouvernance, indexer, déploiements, docs) : Opus.

## Planning réaliste
| Semaine | Travail |
|---|---|
| S1 | Décisions D1–D9 + S0 |
| S2–3 | Branche 1 (token + hook) → début de la demande d'audit du hook |
| S4–5 | Branche 2 (gouvernance) |
| S5–7 | Branche 3 (vault) |
| S7–8 | Branche 4 (indexer) |
| S9–11 | Branche 5 (keeper) + E2E |
| S11–16 | Audit (4–8 semaines) en parallèle des corrections |
| ≈ S14–16 | Mainnet, cap bas |

L'avis juridique (D7) se mène **en parallèle dès la semaine 1**.

## Flux git
`feat/*` → PR vers `staging` (environnement de test) → merge. `staging` → `main` = production. Pipelines CI/CD à ajouter plus tard (staging et prod).

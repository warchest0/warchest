# WARCHEST — État d'avancement (2026-09-27)

Repo : **github.com/warchest0/warchest**. L'historique a été migré depuis aliby00/Warchest le 2026-09-27, et tous les commits sont réécrits au nom de warchest0. Les numéros de PR #1 à #28 cités ci-dessous renvoient à l'ancien repo.

Tout le code est sur **`staging`**. Rien n'a été poussé sur `main` (production).

Flux : `feat/*` → PR → `staging` → (plus tard) `main`. Chaque PR n'a été mergée qu'avec une CI verte, à une exception près : la #9, corrigée par la #10.

## Résumé
| Branche (plan) | Slices | PR |
|---|---|---|
| Recherche (S0) | S0.1 gas mesuré, S0.4 errata, liquidité ETH→USDG | #1–#3, #5 |
| 1 `feat/token-hook` | S1.1–S1.5 | #4, #6, #7, #8 |
| 2 `feat/governance-levels` | S2.1–S2.3 + durcissement (revue adverse) | #9–#13 |
| 3 `feat/treasury-vault` | S3.1–S3.5 + durcissement (revue adverse) | #14–#18, #27 |
| 4 `feat/indexer` | S4.1–S4.4 | #19–#22 |
| 5 `feat/keeper-hyperliquid` | S5.1–S5.4 | #23–#26 |

**Total : 438 tests verts.** Ils se répartissent en 300 pour les contrats (dont les forks mainnet et testnet), 25 pour l'indexer et 113 pour le keeper.

## Slices faites sur Fable (🔁)
- Hook : S1.2 et S1.3.
- Vault : S3.1 à S3.3.
- Keeper : S5.1 à S5.4.
- Deux **revues adverses** (gouvernance, puis vault et distributor) et les corrections du vault.

Toutes les autres slices ont été faites sur Opus.

## Vérifié en réel
- Gas mesuré sur un fork du mainnet 4663 : overhead du hook ≈ 45 k gas, soit ≈ 0,003 $ (RESEARCH §4).
- Uniswap v4 est présent sur le testnet 46630 aux **mêmes adresses** que sur le mainnet, avec un bytecode identique.
- **Cycle on-chain complet** sur un fork du mainnet (`SystemCycleFork`) :
  1. trade de 20 ETH, qui génère 2 ETH de fee ;
  2. conversion TWAP en ≈ 5 394 USDG ;
  3. vote et décision ;
  4. **vrai dépôt Across** ;
  5. fallback D8 ;
  6. clôture, PnL, puis claim via le distributor.
- Les preuves merkle de l'indexer sont acceptées par la vraie gouvernance, déployée sur anvil.
- Signature Hyperliquid **byte-correcte** : 14 vecteurs du SDK officiel reproduits, plus une preuve sur le testnet (adresse recouvrée). L'agent **ne peut pas construire d'action de retrait** : une allowlist dans le code refuse 45 types d'actions.

## Ce qui attend le porteur du projet (bloqué sans toi)
1. **S0.2** : un compte Hyperliquid testnet **financé** (le faucet exige un dépôt préalable sur le mainnet), pour obtenir les preuves brutes qu'un agent ne peut pas faire `withdraw3`, `vaultTransfer` ni `subAccountTransfer`.
2. **S0.3** : un petit transfert Across réel, RH USDG → HyperEVM → HyperCore, puis le retour. C'est de l'argent réel.
3. Mettre en place le compte Hyperliquid : `convertToMultiSigUser`, un sub-account, puis `approveAgent` (expiration ≤ 30 j).
4. Une clé de déploiement financée en ETH testnet, pour `DeploySystem` sur 46630, suivie de 48 h de dry-run du keeper. Le moniteur doit tourner sur une machine séparée.
5. **Décisions produit ou juridiques :**
   - **D7** : distribuer les profits ou faire du buyback & burn. Il faut l'avis juridique **avant** le déploiement mainnet, parce que l'adresse du distributor est immutable dans le vault.
   - **M3** : ajouter ou non une voie de sortie ou de migration du vault. Aujourd'hui elle n'existe pas, par choix de conception : le vault ne peut jamais rien envoyer ailleurs (VAULT.md §10).
   - **Take-profit** : `takeProfitBps` est exprimé en bps du capital. Il faut choisir entre un ordre trigger sur Hyperliquid et un vote de clôture (`TAKE_PROFIT_TRIGGER`, voir keeper/RUNBOOK.md).
6. **Audit externe** (S6.2) : les brouillons sont dans `contracts/docs/AUDIT-REQUEST.md` (UF Security Fund) et `HOOKLIST.md`. Rien n'a été soumis.
7. **Pipelines CI/CD** de staging et de prod, à faire ensemble comme prévu.
8. Recommandé : activer la protection de branche sur `staging`, pour exiger une CI verte avant tout merge.

## Risques résiduels principaux
- **Contrepartie complice** sur Hyperliquid : un agent compromis peut perdre de l'argent en tradant contre un complice. Le keeper ne peut pas l'empêcher. Mitigations en place : liste d'actifs fermée, moniteur indépendant, kill switch.
- **L'USDC bridgé atterrit sur HyperEVM**, sous la clé EVM unique du compte Hyperliquid, avant de passer sur HyperCore sous le multisig (RESEARCH §2.4).
- Gouvernance et distributor : le guardian peut **bloquer**, mais pas choisir. Les rotations d'updater sont différées : ≥ 72 h pour la gouvernance, ≥ 4 j pour le distributor.
- **Juridique** : le schéma est très proche d'un contrat d'investissement (Howey) ou d'un fonds au sens de la réglementation UE (RESEARCH §6).

# WARCHEST keeper — runbook incident

> Périmètre : le bot `keeper/`, le compte Hyperliquid (multisig D4 + sub-account + agent), le bridge Across et les
> appels au `WarchestVault`. Les contrats sont gelés ; rien ici ne modifie un paramètre on-chain.

## 0. Ce que chaque clé peut et ne peut pas faire

| Clé | Détenue par | Peut | Ne peut jamais |
|---|---|---|---|
| Agent Hyperliquid (`HL_AGENT_PRIVATE_KEY`) | keeper | `order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `updateLeverage`, `updateIsolatedMargin`, `scheduleCancel` (allowlist dans `signer.ts`) | retirer, transférer (`withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `usdClassTransfer`, `vaultTransfer`, `subAccountTransfer`), approuver un agent ou un builder |
| Keeper Robinhood (`KEEPER_PRIVATE_KEY`) | keeper | `convertEthToUsdg` (≥ plancher TWAP), `executeDecision` (≤ 20 % NAV, une fois par décision, destinataire immuable), `reportPosition`, `reportClosed`, `reconcile` | envoyer des fonds ailleurs, déclarer un montant revenu, rejouer une décision |
| Multisig HL (D4) | signataires | tout sur le compte HL, dont le retour des fonds | — |
| Guardian (D9) | multisig | `setPaused`, `setKeeper`, révoquer un rapport | déplacer des fonds |

Conséquence : **une compromission du keeper ne peut pas sortir de fonds** ; elle peut au pire mal trader sur
Hyperliquid (RESEARCH §2.3) ou exécuter une décision au mauvais moment. La réponse à toute compromission est la
même : pause + kill switch + rotation des deux clés.

## 1. Commandes

```bash
npm run keeper once            # un tick, en dry-run par défaut (MODE=dry-run)
npm run keeper run             # boucle
npm run keeper status          # runs SQLite + 20 derniers événements
npm run keeper monitor once    # moniteur indépendant ; code 2 = constat rouge
npm run keeper kill "raison"   # MODE=live : cancel all + clôture reduce-only de tout le compte
npm run smoke                  # lecture seule live (RPC, HL /info, Across)
npx tsx scripts/sigproof.ts    # preuve de signature testnet (clé jetable)
```

Le moniteur doit tourner **dans un processus séparé** (`MONITOR_KILL=1` pour qu'il puisse déclencher le kill
switch lui-même) et idéalement sur une machine séparée : il n'a besoin que de la clé d'agent (kill) ou d'aucune clé
(alerte seule).

## 2. Alertes et réponse attendue

| Alerte | Gravité | Réponse |
|---|---|---|
| `keeper key is not the vault keeper` | critique | Le guardian a tourné le keeper ou la config est fausse. Rien ne sera exécuté. Vérifier `vault.keeper()`. |
| `agent not approved on the Hyperliquid account` | critique | Le multisig doit `approveAgent` avec **une nouvelle adresse** (jamais réutiliser une adresse d'agent, RESEARCH §2.1). Mettre à jour `HL_AGENT_PRIVATE_KEY`. |
| `agent expires soon` | warning | Idem, avant `validUntil` (≤ 30 j, D4). Une position ouverte reste protégée par son stop on-chain HL pendant la rotation. |
| `funds on HyperEVM: multisig action required` | warning | Étape 3 de D5 : la clé EVM du multisig envoie l'USDC à `0x2000…0000` (HyperCore), puis `usdClassTransfer` spot → perp, puis `subAccountTransfer` vers le compte de trading. Le keeper attend `withdrawable ≥ 99 %` de `outputAmount`. |
| `openPosition refused` / `executeDecision refused` | critique / warning | Lire la raison (`allowlist`, `delisted`, `max leverage`, `stop-loss beyond safe distance`…). C'est un fail-closed volontaire : ne pas contourner ; si la décision est légitime, corriger la config ou attendre une nouvelle décision. |
| `stop-loss could not be verified, flattening` | critique | Le keeper a déjà aplati. Vérifier sur HL qu'il n'y a plus de position ; sinon `keeper kill`. Ne pas rouvrir à la main : le keeper retentera à la prochaine tick (tentatives bornées). |
| `stop-loss missing while holding: re-protecting` | critique | Quelqu'un a annulé le stop (ou `scheduleCancel` est resté armé). Le keeper repose le stop ; si ça échoue, il aplatit. Chercher la cause (autre agent ? action manuelle du multisig ?). |
| `position margin mode / leverage differs` | critique | Aplati automatiquement. Vérifier qu'aucun autre agent ne change le levier. |
| `monitor <CODE>` | rouge / jaune | Voir §3. |
| `position closed on Hyperliquid (stop, take-profit or liquidation)` | warning | Normal. Le keeper passe en `closed_on_hl` puis émet le plan de retour. |
| `RETURN REQUIRED: multisig must bring the funds back` | critique | Exécuter le plan (§4). |
| `funds not back after the return timeout` | critique | Relancer les signataires. Le vault reste bloqué (aucune nouvelle décision) tant que `reportClosed` + `finalizeClose` ne sont pas passés. |
| `Across deposit expired` / `refunded` | warning | Le SpokePool rembourse le vault (depositor). Le keeper clôt la décision sans trader : `reportClosed` puis `finalizeClose` avec `returned ≈ capital`. |
| `KILL SWITCH` / `kill switch: positions remain` | critique | Si des positions restent : relancer `keeper kill`, sinon fermer à la main depuis le multisig (clé maître). |
| `entry attempts exhausted` | critique | 5 IOC sans fill (liquidité / prix hors borne). Décision humaine : attendre, élargir `ENTRY_SLIPPAGE_BPS`, ou laisser expirer. |

## 3. Codes du moniteur

| Code | Sens | Action |
|---|---|---|
| `POSITION_WITHOUT_VAULT` | position HL alors que le vault n'a pas de position | Kill switch. Quelqu'un trade avec le compte. Rotation de l'agent. |
| `FOREIGN_POSITION` / `ASSET_NOT_ALLOWED` | coin ≠ décision | Kill switch. |
| `SIDE_MISMATCH`, `MARGIN_MODE`, `LEVERAGE`, `SIZE_EXCEEDS` | position non conforme à `riskParams` | Kill switch (le keeper l'aurait déjà aplatie ; vérifier qu'il tourne). |
| `STOP_MISSING`, `STOP_TOO_FAR` | protection absente ou trop lâche | Le keeper repose le stop. Si le code persiste plus d'un intervalle : kill switch. |
| `UNEXPECTED_ORDER` | ordre non reduce-only ou sur un autre coin | Rouge si non reduce-only : kill switch. Jaune sinon : investiguer. |
| `AGENT_MISSING` / `AGENT_EXPIRING` | agent | Rotation (§2). |
| `MUST_CLOSE` | le vault demande la clôture | Vérifier que le keeper est en `closing` ; sinon `keeper kill`. |

## 4. Retour des fonds (signé par le multisig, jamais par le keeper)

Le keeper émet un `RETURN PLAN` (alerte + log) avec les montants exacts. Ordre des étapes :
1. `subAccountTransfer` du sub-account vers le maître (si sub-account).
2. `usdClassTransfer` perp → spot sur le maître.
3. `spotSend` USDC vers l'adresse système `0x2000000000000000000000000000000000000000` (HyperCore → HyperEVM).
4. Sur HyperEVM (999), un dépôt Across par morceau (`/limits`, ≈ 246 k$ instantané) : `inputToken` USDC
   `0xb883…630f`, `outputToken` USDG `0x5fc5…d168`, `destinationChainId` 4663, **`recipient` = le vault**,
   `outputAmount` ≥ quote fraîche (`/suggested-fees`, re-quoter au moment de signer : `quoteTimestamp` ≤ 1 h,
   `fillDeadline` ≤ 6 h).
5. Le keeper voit `balance − usdgLedger ≥ RETURN_TOLERANCE_BPS × attendu` et envoie `reportClosed` ; 6 h plus
   tard n'importe qui peut `finalizeClose`. Les morceaux qui arrivent après sont comptés par `reconcile`.

Alternative : `withdraw3` vers Arbitrum (~3–5 min, 1 $) puis Across `42161 USDC → 4663 USDG` vers le vault.

Si une partie du capital est **définitivement perdue** (liquidation) : le retour est partiel ; utiliser
`FORCE_REPORT_CLOSED_ID=<id>` pour que le keeper envoie `reportClosed` sous le seuil. Le guardian dispose de 6 h
pour révoquer. Ne jamais forcer tant que des fonds restent sur Hyperliquid.

## 5. Procédures

### 5.1 Pause (guardian) ⇒ débouclage
`vault.setPaused(true)` ⇒ `mustClose()` vrai ⇒ à la tick suivante le keeper annule les ordres, ferme en reduce-only,
émet le plan de retour. `reportClosed` et `finalizeClose` restent autorisés en pause. La position n'est **pas**
rouverte au dépausage (D8 : il faut une nouvelle décision quorate).

### 5.2 Clé d'agent compromise
1. `keeper kill` (ou laisser le moniteur le faire) ; 2. le multisig révoque l'agent (`approveAgent` d'une nouvelle
adresse, l'ancienne n'est plus utilisable après expiration ; pour un effet immédiat, déplacer les fonds hors du
sub-account : `subAccountTransfer` vers le maître) ; 3. nouvelle `HL_AGENT_PRIVATE_KEY` ; 4. redémarrer.

### 5.3 Clé keeper Robinhood compromise
1. Guardian : `setPaused(true)` puis `setKeeper(nouvelle adresse)` ; 2. pertes maximales bornées par le vault
(`VAULT.md` §4–5) ; 3. redémarrer avec la nouvelle clé, dépauser.

### 5.4 Keeper arrêté / base SQLite perdue
Redémarrer. Une position ouverte sans historique local est **adoptée** depuis l'état on-chain + HL (stage déduit :
`protecting` si position, `opening` si USDC disponible, `funding` si dépôt rempli, sinon `bridging`) ; la
protection est re-vérifiée avant de passer en `holding`. Les `cloid` déterministes empêchent tout double envoi.

### 5.5 Hyperliquid indisponible
Le stop-loss est un trigger **on-chain HL** : il reste actif sans le keeper. Le keeper retente avec backoff
(≤ 10 min). Ne rien faire tant que `/info` ne répond pas ; ne pas armer `scheduleCancel`.

### 5.6 Across ne remplit pas
`fillDeadline` (≤ 6 h) passé ⇒ remboursement au vault dans un bundle ultérieur (peut prendre des heures). Le keeper
attend et clôt sans trader. Ne pas relancer `executeDecision` : la décision est déjà consommée (`id ≤ last`).

### 5.7 Décision sur un actif hors allowlist / délisté
Refus fail-closed, alerte. La décision expire (`maxDecisionAge`) ; la gouvernance doit revoter. Ne pas élargir
`ALLOWED_ASSETS` sous pression.

### 5.8 Dead-man switch resté armé
`scheduleCancel` annule **aussi le stop**. Symptôme : `STOP_MISSING` à intervalle régulier. Réponse : le keeper
repose le stop ; désarmer avec `scheduleCancel` sans `time` (le keeper le fait à la prochaine entrée) et vérifier
`DEADMAN_MS`.

## 6. Avant tout capital réel (bloquants humains)
- [ ] S0.2 : preuves brutes de rejet `withdraw3` / `usdSend` / `vaultTransfer` / `subAccountTransfer` /
      `approveAgent` par un agent sur le testnet HL, sur un compte **financé** (le faucet exige un dépôt mainnet).
- [ ] Compte HL converti en multisig (`convertToMultiSigUser`), sub-account créé, agent approuvé ≤ 30 j.
- [ ] S0.3 : petit transfert Across réel RH → HyperEVM → HyperCore et retour ; mesurer délais, frais, étapes.
- [ ] `HL_ACCOUNT` = `vault.bridgeRecipient()` (immuable) ; `ALLOWED_ASSETS` = noms des `eligibleAssets` de la
      gouvernance sur le réseau HL visé (les index diffèrent entre mainnet et testnet).
- [ ] Moniteur sur une machine séparée avec `MONITOR_KILL=1`.
- [ ] 48 h de `MODE=dry-run` sans erreur (critère S5.1 du plan).

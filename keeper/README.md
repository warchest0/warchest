# WARCHEST — keeper

Bot off-chain (Node ≥ 24, TypeScript, viem, `node:sqlite`) qui exécute les décisions de gouvernance sur Hyperliquid :

1. lit `governance.currentDecision()` et l'état du vault (source de vérité, jamais inventé) ;
2. convertit l'ETH du vault en USDG (`convertEthToUsdg`, borné par le plancher TWAP on-chain) ;
3. bridge le capital via Across (`executeDecision`, paramètres pris sur `/suggested-fees` et `/limits`) ;
4. ouvre la position sur Hyperliquid avec l'**agent trading-only** (marge isolée, levier du vault), pose le stop-loss
   et le take-profit **après** le fill et les relit ;
5. rapporte l'equity (`reportPosition`), ferme quand `mustClose()` est vrai, prépare les instructions de retour pour
   le **multisig** (D4 : le keeper ne signe jamais un retrait), puis `reportClosed` / `finalizeClose` / `reconcile`.

```bash
npm ci
npm test            # unitaires + intégration anvil (contrats réels, sautée sans anvil/artefacts)
npm run smoke       # lecture seule LIVE : RPC Robinhood mainnet, Hyperliquid /info, API Across
npm run keeper once # un tick (dry-run par défaut)
npm run keeper run  # boucle
npm run keeper status
```

## Modes
- **`MODE=dry-run`** (défaut) : lit tout, calcule et logge chaque action prévue (`WOULD …`), ne signe rien.
- **`MODE=live`** : signe les tx du vault avec `KEEPER_PRIVATE_KEY` et les actions L1 Hyperliquid avec
  `HL_AGENT_PRIVATE_KEY`. Refusé sur Robinhood mainnet sans `ALLOW_MAINNET=1`. Câblé par S5.2–S5.4.

Configuration : voir `.env.example`.

## Invariants de sécurité
- **L'agent Hyperliquid ne peut jamais retirer.** Le keeper ne détient que la clé d'agent et ne construit que des
  actions L1 (`order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `updateLeverage`, `updateIsolatedMargin`,
  `scheduleCancel`). Tout autre type d'action est refusé **dans la couche de signature** (allowlist, S5.2) ; le
  domaine EIP-712 `HyperliquidSignTransaction` (retraits, transferts, `approveAgent`…) n'existe pas dans le code.
- **Le vault et la gouvernance sont la source de vérité** : actif et sens = `currentDecision()`, levier / stop /
  take-profit = `vault.riskParams()` (immuables), capital = position enregistrée par le vault. Chaque borne du vault
  (`_checkDecision`, `_checkOrder`, fenêtres du SpokePool) est re-vérifiée localement avant de construire une tx
  (`src/planner.ts`).
- **Liste fermée d'actifs** (`ALLOWED_ASSETS`, défaut `BTC,ETH,SOL`) : une décision hors liste, un actif délisté ou
  un index inconnu sont refusés (fail-closed), et signalés.
- **Fail-closed sur la protection** : si le stop-loss ne peut pas être relu dans `frontendOpenOrders`, la position
  est aplatie.
- **Retour des fonds** : `reportClosed` n'est envoyé qu'une fois ≥ `RETURN_TOLERANCE_BPS` de l'equity attendue
  revenue sur le vault (`balance − usdgLedger`), ou avec l'override explicite `FORCE_REPORT_CLOSED_ID`.

## Cycle de vie d'une décision (`src/keeper.ts`, persisté dans SQLite)
```
idle ──executeDecision──▶ bridging ──fill Across──▶ funding ──USDC sur le compte de trading (multisig)──▶ opening
  ──IOC rempli──▶ protecting ──stop relu──▶ holding ──mustClose / stop / TP──▶ closing ──flat──▶ closed_on_hl
  ──instructions au multisig──▶ awaiting_return ──USDG revenu──▶ report_closed ──fenêtre 6 h──▶ finalized
```
Chaque étape est re-dérivée de l'état observé (vault, gouvernance, Hyperliquid, Across) : un redémarrage reprend au
bon endroit, et une position sans historique local est **adoptée** depuis la chaîne.

## Étape 3 de D5 (HyperEVM → HyperCore) et retour
Le keeper ne peut pas déplacer des fonds sur HyperEVM ni sur HyperCore (clé d'agent). Il **attend** l'USDC sur le
compte de trading et publie les instructions (alerte) : transfert HyperEVM → adresse système `0x2000…0000`,
`usdClassTransfer`, `subAccountTransfer`. Idem pour le retour (S5.4) : `withdraw3` / Across `999 → 4663` découpé
selon `/limits`, signés par le multisig.

## Prise de profit
`TAKE_PROFIT_TRIGGER=1` (défaut) pose un trigger « take profit » à `takeProfitBps / leverage` du prix d'entrée, soit
`takeProfitBps` du capital. Avec `0`, le keeper ne pose que le stop et laisse la gouvernance voter la clôture via
`closeVoteAllowed` (equity rapportée ≥ seuil). Le choix appartient au porteur.

## Smoke test live (2026-09-27, lecture seule)
```
[rpc] chainId=4663 block=73667949
[across spoke pool] numberOfDeposits=373002 depositQuoteTimeBuffer=3600 fillDeadlineBuffer=21600
[quoter v2] 1 ETH → 2691.49 USDG
[hl] 0=BTC szDecimals=5 maxLev=40 mid=84295.5 → long 3x: entry≤84296 stop=80080 tp=87102
[hl] 1=ETH szDecimals=4 maxLev=25 mid=2692.85 → long 3x: entry≤2692.9 stop=2558.2 tp=2782.5
[hl] 5=SOL szDecimals=2 maxLev=20 mid=120.145 → long 3x: entry≤120.15 stop=114.13 tp=124.14
[across] 4663 USDG → 999 USDC: min=0.50 maxInstant=260534.15 max=542794.73
[across] 10000$ → out=9994.00 fee=6bps eta=2s  (quoteTs +7200s = fillDeadline)
[across] 100000$ → out=99940.00 fee=5bps eta=98s
[across] 999 USDC → 4663 USDG (retour): min=0.50 maxInstant=246229.76 max=246229.76
```

## Tests
- `rounding` : règles tick/lot Hyperliquid (5 chiffres significatifs, `6 − szDecimals` décimales), arithmétique
  décimale exacte ;
- `planner` : chaque borne du vault et du SpokePool, allowlist, dimensionnement, prix de protection ;
- `keeper` : machine à états complète avec exécuteur scripté (fill partiel, stop manquant, stop non vérifié →
  aplatissement, remboursement Across, timeout du retour, override, adoption, expiration de l'agent) ;
- `chain.integration` : vrais `WarchestGovernance` + `WarchestVault` sur anvil (décision quorate réelle, conversion
  réelle, plan `executeDecision` valide).

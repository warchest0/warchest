# Déploiement — token + hook + pool (S1.4)

Uniswap v4 est déployé **aux mêmes adresses** sur le testnet (46630) et le mainnet (4663). Un seul script couvre les deux.

## Prérequis
- Une clé déployeur avec de l'ETH testnet. Il en faut environ 0,05 ETH pour le gas, plus `LP_ETH_AMOUNT`.
  - Le déployeur reçoit toute la supply, initialise le pool et possède la position LP.
- `WARCHEST_VAULT` : destinataire des fees, **immutable dans le hook**.
  - Sur testnet, on peut mettre une adresse temporaire, en attendant le vault de S3.
  - Sur mainnet, le vault doit être déployé **avant** le hook, et doit accepter l'ETH natif de n'importe qui.

## Commande
```bash
cd contracts
export WARCHEST_VAULT=0x...        # obligatoire
export LP_TOKEN_AMOUNT=...         # en wei, par défaut toute la supply
export LP_ETH_AMOUNT=...           # en wei, par défaut 1 ETH
forge script script/DeployWarchest.s.sol \
  --rpc-url robinhood_testnet --account <keystore> --broadcast \
  --verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```

Le script déroule, dans l'ordre :
1. Déploie `WarchestToken`.
2. Mine le salt du hook (flags `0x20CC`) et le déploie via CREATE2 (`0x4e59…956C`).
3. Appelle `PoolManager.initialize` **directement**, au prix `LP_TOKEN_AMOUNT / LP_ETH_AMOUNT`.
4. Crée la position LP full-range via le PositionManager officiel (Permit2).

## Vérifié
- `test/fork/DeployWarchestFork.t.sol` rejoue tout le lancement sur un fork du testnet et un fork du mainnet. Il fait ensuite un achat de 1 ETH, puis `flush()`, et vérifie que le vault reçoit 0,1 ETH − 1 wei.
- `forge script … --broadcast` a aussi été exécuté contre un anvil forké du testnet, sans erreur.

## Pièges
- Ne **jamais** initialiser le pool via la multicall du PositionManager : le hook exige `sender == initializer`.
- Le pool est protégé contre un front-run de l'initialisation, puisque seul `initializer` peut l'appeler. En revanche le **prix initial** reste celui choisi par le déployeur, donc à vérifier deux fois.
- Hook allowlist : voir `HOOKLIST.md`. Sans validation, l'app et l'API Uniswap ne routent pas le pool.

---

# Déploiement du système complet (S3.5)

`script/DeploySystem.s.sol` déploie et relie tout, dans le seul ordre valide :
1. Gouvernance.
2. Distributor, si activé.
3. Vault.
4. `governance.setVault`, puis `setEligibleAssets` (BTC, ETH, SOL), puis `distributor.setVault`.
5. Token, hook (dont le destinataire des fees est le vault qui vient d'être déployé), pool et liquidité.
6. Lancement du **transfert du rôle guardian** vers le multisig.

```bash
export GUARDIAN=0x...   # multisig
export UPDATER=0x...    # indexer
export KEEPER=0x...     # bot
export HL_ACCOUNT=0x... # compte Hyperliquid (multisig natif HL, D4) — IMMUTABLE dans le vault
export ENABLE_DISTRIBUTOR=false   # D7 : à trancher après l'avis juridique
forge script script/DeploySystem.s.sol --rpc-url robinhood --account <keystore> --broadcast --verify
```

Une fois le script terminé, le multisig doit appeler `acceptGuardian()` sur la gouvernance, le vault et le distributor.

**Vérifié** par `test/fork/SystemCycleFork.t.sol`, sur un fork du mainnet 4663 avec le vrai PoolManager v4, le vrai pool v3 WETH/USDG et le vrai SpokePool Across. Le test déroule :
1. déploiement et branchement ;
2. achat de 20 ETH, qui envoie 2 ETH de fee au vault ;
3. conversion en ≈ 5 394 USDG au prix TWAP ;
4. snapshot, vote, quorum, décision 1 ;
5. ordre ≤ 20 % de la NAV, avec un vrai dépôt Across ;
6. round sans quorum : on garde le même id, et rien n'est exécuté (D8) ;
7. nouvelle décision : `mustClose` passe à vrai ;
8. clôture, retour des fonds à +25 %, PnL comptabilisé ;
9. financement du distributor, puis claim.

Seules la jambe Hyperliquid et le fill retour du bridge sont simulés. Ils seront couverts en S5.

Réseau de test :
- Le PoolManager et le SpokePool ne posent pas de problème : v4 est présent sur 46630 et `MockAcrossSpokePool` remplace le SpokePool (D6).
- En revanche, il n'y a pas de pool v3 WETH/USDG sur le testnet. L'E2E testnet (S5.5) devra donc déployer un pool WETH/USDG mock avec son oracle.

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

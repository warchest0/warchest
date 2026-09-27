# WARCHEST — contracts

Foundry. Dépendances en submodules (versions épinglées) :
- `v4-core` v4.0.0
- `openzeppelin-contracts` v5.7.0
- `uniswap-hooks` v1.2.1
- `v4-periphery`

```bash
git submodule update --init --recursive
cp .env.example .env   # RPC Robinhood Chain (fork tests)
forge test
```

| Contrat | Rôle |
|---|---|
| `WarchestToken` | ERC20 pur, supply fixe, **zéro taxe** |
| `WarchestHook` | Hook v4 qui prélève 10 % en ETH au swap et l'envoie au vault *(S1.2)* |

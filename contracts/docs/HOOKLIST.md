# Uniswap hook allowlist submission (draft, to be submitted after the audit)

Reference: https://developers.uniswap.org/hook-allowlist — PR on https://github.com/Uniswap/hooklist
Comparable precedent on Robinhood Chain: TaxHook, PR #10290 (10% in afterSwap, verified source).

| Field | Value |
|---|---|
| Chain | Robinhood Chain (4663) |
| Hook address | _after the mainnet deployment_ |
| Verified source | Blockscout `robinhoodchain.blockscout.com`, mandatory |
| Flags | beforeInitialize, beforeSwap, afterSwap, beforeSwapReturnsDelta, afterSwapReturnsDelta (`0x20CC`) |
| Behavior | 10% fee on the gross ETH amount, always in native ETH, on both buys and sells. Stored as ERC-6909 claims, then permissionless `flush()` to an immutable vault. |
| Admin / upgrade | None: no owner, constant fee, no proxy |
| Allowed pool | Only one: ETH/WAR, initialized by the immutable `initializer` address |
| Audit | _report to be attached (S1.5 / S6.2)_ |
| Limitations | An exactIn buy or an exactOut sell whose fill would be partial **reverts** (anti-overcharging, see HOOK.md) |

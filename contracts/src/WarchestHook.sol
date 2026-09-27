// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IHookEvents} from "@openzeppelin/uniswap-hooks/interfaces/IHookEvents.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title WarchestHook
/// @notice Uniswap v4 hook charging a constant 10% fee, always denominated in native ETH, on every swap of the
///         single canonical ETH/WARCHEST pool. Fees accrue as ERC-6909 claims owned by the hook and are forwarded to an
///         immutable vault by the permissionless {flush}.
///
/// @dev ## Pool layout
///      Native ETH is `address(0)`, so it is always `currency0`; the token is `currency1`. Hence
///      `zeroForOne == true` is a BUY (ETH in, token out) and `zeroForOne == false` is a SELL (token in, ETH out).
///
///      ## Fee definition
///      The fee is 10% of the *gross* ETH leg of the swap, i.e. the ETH that leaves the buyer or the ETH the pool pays
///      out to the seller, in all four cases:
///
///      | Case          | Specified currency | Charged in   | Formula                                            |
///      |---------------|--------------------|--------------|----------------------------------------------------|
///      | BUY exactIn   | ETH                | beforeSwap   | user pays X; fee = 10% of X; pool receives X - fee |
///      | BUY exactOut  | token              | afterSwap    | pool needs P; fee = P/9; user pays P + fee         |
///      | SELL exactIn  | token              | afterSwap    | pool pays G; fee = 10% of G; user receives G - fee |
///      | SELL exactOut | ETH                | beforeSwap   | user wants X; pool pays X + X/9; fee = X/9         |
///
///      With `fee = P/9` (resp. `X/9`) the fee is exactly 10% of the gross `P + fee` (resp. `X + fee`).
///
///      ## Rounding
///      Every division rounds UP (in favour of the vault). Because the divisors are 10 and 9, the rounding error is
///      bounded by `0 <= fee - 10% * gross < 1 wei` in all four cases:
///      - `ceil(G / 10) - G / 10 < 1`;
///      - with `fee = ceil(N / 9)`, `fee - (N + fee) / 10 = (9 * fee - N) / 10 <= 8 / 10`.
///      Rounding up never breaks the swap: `ceil(X / 10) <= X` for any `X >= 1`, so the specified amount keeps its
///      sign and `HookDeltaExceedsSwapAmount` cannot trigger. For dust buys of fewer than 10 wei, the whole amount is
///      taken as fee and the pool swaps nothing; this is documented rather than special-cased.
///
///      ## Partial fills
///      When ETH is the specified currency the fee is computed in `beforeSwap` from the *requested* amount. If the pool
///      then fills only part of it (a `sqrtPriceLimitX96` is reached, or liquidity runs out) the fee would exceed 10%
///      of the realised gross, and in the SELL exactOut case the trader could even end up paying ETH. `afterSwap`
///      therefore verifies that the pool moved exactly the amount `beforeSwap` planned for, and reverts with
///      {PartialFill} otherwise. Routers use extreme price limits, so this only surfaces when the pool cannot serve the
///      request at all. When ETH is the unspecified currency the fee is computed on the realised amount in
///      `afterSwap`, so partial fills are charged exactly 10% and are allowed.
///
///      ## Fee delivery
///      The fee is minted to the hook as ERC-6909 claims on the PoolManager instead of being pushed to the vault with
///      a native `take` during the swap. This (1) removes a denial-of-service vector: a vault that reverts on receive
///      (paused, mis-deployed, self-destructed proxy) would otherwise block every swap; (2) performs no external call
///      to a third-party contract while the PoolManager is unlocked, so the vault can never re-enter the swap; and
///      (3) is cheaper per swap than a native transfer to a cold address. Anyone can call {flush} to burn the claims
///      and send the ETH to the immutable vault; it leaves 1 wei of claims behind as a storage-slot warm-keeper.
///
///      ## Trust model
///      No owner, no admin, no upgradeability, no fee setter. Every parameter is immutable or constant.
contract WarchestHook is BaseHook, IHookEvents, IUnlockCallback {
    using SafeCast for uint256;
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;

    /// @notice Fee in basis points of the gross ETH leg (10%).
    uint256 public constant FEE_BPS = 1_000;
    /// @notice Basis-points denominator.
    uint256 public constant BPS = 10_000;

    /// @notice The only token allowed as `currency1` of a pool using this hook.
    Currency public immutable token;
    /// @notice Recipient of all collected fees. Immutable by design.
    address public immutable vault;
    /// @notice The only address allowed to initialise the canonical pool (prevents a front-run initialisation at a
    ///         manipulated price). It must call `PoolManager.initialize` directly.
    address public immutable initializer;

    /// @notice Id of the canonical pool, zero until it is initialised. Only one pool can ever use this hook.
    PoolId public poolId;

    /// @notice Emitted when {flush} forwards accrued fees to the vault.
    event FeesFlushed(address indexed caller, uint256 amount);

    error ZeroAddress();
    error UnauthorizedInitializer(address sender);
    error InvalidPoolCurrencies();
    error DynamicFeeNotSupported();
    error PoolAlreadyInitialized();
    /// @notice The pool did not move exactly the ETH amount the fee was computed on.
    error PartialFill(uint256 expected, uint256 actual);
    error NothingToFlush();

    /// @param _poolManager The Uniswap v4 PoolManager.
    /// @param _token The WarchestToken address (currency1 of the canonical pool).
    /// @param _vault Immutable recipient of the fees.
    /// @param _initializer The only address allowed to initialise the pool.
    constructor(IPoolManager _poolManager, address _token, address _vault, address _initializer)
        BaseHook(_poolManager)
    {
        if (_token == address(0) || _vault == address(0) || _initializer == address(0)) {
            revert ZeroAddress();
        }
        token = Currency.wrap(_token);
        vault = _vault;
        initializer = _initializer;
    }

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Fee math (pure, exposed for integrators and tests)
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Fee on a gross ETH amount: `ceil(gross * 10%)`.
    function feeOnGross(uint256 gross) public pure returns (uint256) {
        return Math.mulDiv(gross, FEE_BPS, BPS, Math.Rounding.Ceil);
    }

    /// @notice Fee on a net ETH amount such that the fee is 10% of `net + fee`: `ceil(net / 9)`.
    function feeOnNet(uint256 net) public pure returns (uint256) {
        return Math.mulDiv(net, FEE_BPS, BPS - FEE_BPS, Math.Rounding.Ceil);
    }

    /// @notice ETH fee claims accrued and not yet flushed to the vault (includes the 1 wei left by {flush}).
    function pendingFees() public view returns (uint256) {
        return poolManager.balanceOf(address(this), CurrencyLibrary.ADDRESS_ZERO.toId());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Fee delivery
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Burns the accrued ERC-6909 ETH claims and sends the ETH to the immutable vault. Permissionless.
    /// @dev Leaves exactly 1 wei of claims behind so that the hook's ERC-6909 balance slot never returns to zero:
    ///      the next swap then pays a ~2.9k-gas SSTORE instead of a ~20k-gas zero-to-non-zero write.
    /// @return amount The amount of ETH forwarded (`pendingFees() - 1`).
    function flush() external returns (uint256 amount) {
        uint256 pending = pendingFees();
        if (pending <= 1) revert NothingToFlush();
        amount = pending - 1;
        emit FeesFlushed(msg.sender, amount);
        // forge-lint: disable-next-line(unused-return)
        poolManager.unlock(abi.encode(amount));
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only reachable through {flush}: the PoolManager calls back the address that called `unlock`.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        uint256 amount = abi.decode(data, (uint256));
        poolManager.burn(address(this), CurrencyLibrary.ADDRESS_ZERO.toId(), amount);
        poolManager.take(CurrencyLibrary.ADDRESS_ZERO, vault, amount);
        return "";
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Hook entry points
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Only the immutable `initializer` may create a pool with this hook, it must be ETH/token, use a static LP
    ///      fee, and it can only be done once. `key.hooks == this` is guaranteed by the PoolManager.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal override returns (bytes4) {
        if (sender != initializer) revert UnauthorizedInitializer(sender);
        if (!key.currency0.isAddressZero() || !(key.currency1 == token)) revert InvalidPoolCurrencies();
        if (key.fee.isDynamicFee()) revert DynamicFeeNotSupported();
        if (PoolId.unwrap(poolId) != bytes32(0)) revert PoolAlreadyInitialized();
        poolId = key.toId();
        return IHooks.beforeInitialize.selector;
    }

    /// @dev Charges the fee when ETH is the specified currency (BUY exactIn, SELL exactOut). Returning a positive
    ///      specified delta credits the hook and shrinks the exact-input amount the pool swaps (BUY) or grows the
    ///      exact-output amount the pool must pay (SELL); the swapper pays / receives the difference.
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!_ethIsSpecified(params)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 fee = _plannedFee(params);
        int128 feeDelta = fee.toInt128();
        _collect(key, sender, fee);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(feeDelta, 0), 0);
    }

    /// @dev When ETH is the specified currency, enforces that the pool moved exactly the planned amount (see
    ///      "Partial fills"). Otherwise charges the fee on the realised ETH leg (BUY exactOut, SELL exactIn) by
    ///      returning a positive unspecified delta, which credits the hook and is paid by the swapper.
    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        // Raw pool delta for the swapper, before hook deltas are applied: < 0 the swapper pays ETH, > 0 receives ETH.
        int256 ethDelta = delta.amount0();

        if (_ethIsSpecified(params)) {
            // BUY exactIn:   amountSpecified = -X, the pool must have taken exactly X - fee  => delta0 == -X + fee.
            // SELL exactOut: amountSpecified = +X, the pool must have paid exactly X + fee   => delta0 == X + fee.
            // The cast is safe: `beforeSwap` already validated `_plannedFee(params)` fits in an int128.
            // forge-lint: disable-next-line(unsafe-typecast)
            int256 expected = params.amountSpecified + int256(_plannedFee(params));
            if (ethDelta != expected) revert PartialFill(_abs(expected), _abs(ethDelta));
            return (IHooks.afterSwap.selector, 0);
        }

        uint256 realisedFee;
        if (params.zeroForOne) {
            // BUY exactOut: the pool needs P = -ethDelta from the buyer; fee = P / 9 so that fee == 10% of (P + fee).
            realisedFee = feeOnNet(_abs(ethDelta));
        } else {
            // SELL exactIn: the pool pays G = ethDelta to the seller; fee = 10% of G.
            realisedFee = feeOnGross(_abs(ethDelta));
        }
        int128 feeDelta = realisedFee.toInt128();
        _collect(key, sender, realisedFee);
        return (IHooks.afterSwap.selector, feeDelta);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev ETH (currency0) is the specified currency iff `exactInput == zeroForOne`.
    function _ethIsSpecified(SwapParams calldata params) internal pure returns (bool) {
        return (params.amountSpecified < 0) == params.zeroForOne;
    }

    /// @dev Fee computed from the specified ETH amount (BUY exactIn on the gross input, SELL exactOut on the net
    ///      output). Pure function of `params`, so `beforeSwap` and `afterSwap` agree without any storage.
    function _plannedFee(SwapParams calldata params) internal pure returns (uint256) {
        return
            params.amountSpecified < 0
                ? feeOnGross(_abs(params.amountSpecified))
                : feeOnNet(_abs(params.amountSpecified));
    }

    /// @dev Mints the fee to the hook as ERC-6909 claims and emits the standard {HookFee} event.
    function _collect(PoolKey calldata key, address sender, uint256 fee) internal {
        if (fee == 0) return;
        emit HookFee(PoolId.unwrap(key.toId()), sender, fee.toUint128(), 0);
        poolManager.mint(address(this), CurrencyLibrary.ADDRESS_ZERO.toId(), fee);
    }

    /// @dev Reverts on `type(int256).min` (checked negation), which the PoolManager could not handle anyway.
    function _abs(int256 x) internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return x < 0 ? uint256(-x) : uint256(x); // both operands are non-negative here
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Plan, Planner} from "@uniswap/v4-periphery/test/shared/Planner.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {WarchestHookFixture, MockVault} from "../utils/WarchestHookFixture.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice The official UniversalRouter and Permit2 deployed on Robinhood Chain mainnet, against the real
///         PoolManager, for the four swap kinds. Also measures end-to-end gas through the router.
/// @dev Requires `ROBINHOOD_RPC_URL`; skipped otherwise.
contract WarchestHookRouterForkTest is WarchestHookFixture {
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IUniversalRouter constant UR = IUniversalRouter(0x8876789976dEcBfCbBbe364623C63652db8C0904);
    IPermit2 constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    bytes1 constant V4_SWAP = 0x10;

    bool forked;
    MockVault vault;
    Currency WAR;

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        manager = MANAGER;
        _deployRouters();
        vault = new MockVault();
        _deployWarchest(address(vault));
        _initPools(SQRT_PRICE_1_1);
        vm.deal(address(this), 1e24);
        _addLiquidityBoth(FULL_LOWER, FULL_UPPER, 10_000 ether, 20_000 ether);
        WAR = Currency.wrap(address(token));

        // Permit2 flow for token input: user approves Permit2, Permit2 approves the router
        token.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(token), address(UR), type(uint160).max, type(uint48).max);
        // steady state: the hook already holds claims
        _buyExactIn(hookedKey, 1);
    }

    function _execute(Plan memory plan, Currency input, Currency output, uint256 value) internal returns (uint256 gas) {
        bytes memory v4 = plan.finalizeSwap(input, output, address(this));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = v4;
        uint256 g0 = gasleft();
        UR.execute{value: value}(abi.encodePacked(V4_SWAP), inputs, block.timestamp + 1 hours);
        gas = g0 - gasleft();
    }

    function _cool() internal {
        vm.cool(address(manager));
        vm.cool(address(hook));
        vm.cool(address(token));
        vm.cool(address(UR));
        vm.cool(address(PERMIT2));
    }

    function test_forkUR_buyExactIn() public onlyFork {
        uint256 x = 1 ether;
        uint256 fee = _feeOnGross(x);
        BalanceDelta ref = _buyExactIn(refKey, x - fee);
        Plan memory plan = Planner.init()
            .add(
                Actions.SWAP_EXACT_IN_SINGLE,
                abi.encode(IV4Router.ExactInputSingleParams(hookedKey, true, uint128(x), 0, 0, ""))
            );
        uint256 pendingBefore = hook.pendingFees();
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        _cool();
        uint256 gas = _execute(plan, CurrencyLibrary.ADDRESS_ZERO, WAR, x);
        console2.log("UniversalRouter BUY exactIn 1 ETH gas", gas);
        assertEq(ethBefore - address(this).balance, x);
        assertEq(token.balanceOf(address(this)) - tokBefore, uint256(int256(ref.amount1())));
        assertEq(hook.pendingFees() - pendingBefore, fee);
    }

    function test_forkUR_buyExactOut() public onlyFork {
        uint256 t = 500 ether;
        BalanceDelta ref = _buyExactOut(refKey, t, 1e23);
        uint256 p = uint256(-int256(ref.amount0()));
        uint256 fee = _feeOnNet(p);
        Plan memory plan = Planner.init()
            .add(
                Actions.SWAP_EXACT_OUT_SINGLE,
                abi.encode(IV4Router.ExactOutputSingleParams(hookedKey, true, uint128(t), type(uint128).max, 0, ""))
            );
        uint256 pendingBefore = hook.pendingFees();
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        _cool();
        // exact value: the reference pool is in the same state, so P + fee is known exactly
        uint256 gas = _execute(plan, CurrencyLibrary.ADDRESS_ZERO, WAR, p + fee);
        console2.log("UniversalRouter BUY exactOut 500 WAR gas", gas);
        assertEq(token.balanceOf(address(this)) - tokBefore, t);
        assertEq(ethBefore - address(this).balance, p + fee);
        assertEq(hook.pendingFees() - pendingBefore, fee);
    }

    function test_forkUR_sellExactIn() public onlyFork {
        uint256 t = 1 ether;
        BalanceDelta ref = _sellExactIn(refKey, t);
        uint256 g = uint256(int256(ref.amount0()));
        uint256 fee = _feeOnGross(g);
        Plan memory plan = Planner.init()
            .add(
                Actions.SWAP_EXACT_IN_SINGLE,
                abi.encode(IV4Router.ExactInputSingleParams(hookedKey, false, uint128(t), 0, 0, ""))
            );
        uint256 pendingBefore = hook.pendingFees();
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        _cool();
        uint256 gas = _execute(plan, WAR, CurrencyLibrary.ADDRESS_ZERO, 0);
        console2.log("UniversalRouter SELL exactIn 1 WAR gas", gas);
        assertEq(tokBefore - token.balanceOf(address(this)), t);
        assertEq(address(this).balance - ethBefore, g - fee);
        assertEq(hook.pendingFees() - pendingBefore, fee);
    }

    function test_forkUR_sellExactOut() public onlyFork {
        uint256 x = 0.5 ether;
        uint256 fee = _feeOnNet(x);
        BalanceDelta ref = _sellExactOut(refKey, x + fee);
        Plan memory plan = Planner.init()
            .add(
                Actions.SWAP_EXACT_OUT_SINGLE,
                abi.encode(IV4Router.ExactOutputSingleParams(hookedKey, false, uint128(x), type(uint128).max, 0, ""))
            );
        uint256 pendingBefore = hook.pendingFees();
        uint256 ethBefore = address(this).balance;
        uint256 tokBefore = token.balanceOf(address(this));
        _cool();
        uint256 gas = _execute(plan, WAR, CurrencyLibrary.ADDRESS_ZERO, 0);
        console2.log("UniversalRouter SELL exactOut 0.5 ETH gas", gas);
        assertEq(address(this).balance - ethBefore, x, "exact net ETH");
        assertEq(tokBefore - token.balanceOf(address(this)), uint256(-int256(ref.amount1())));
        assertEq(hook.pendingFees() - pendingBefore, fee);
    }

    /// @dev exactOut gas through PoolSwapTest, comparable with RESEARCH.md §4.1 (cold state, steady-state claims).
    function test_fork_exactOutGas() public onlyFork {
        BalanceDelta ref = _buyExactOut(refKey, 1 ether, 1e23);
        uint256 p = uint256(-int256(ref.amount0()));
        _cool();
        uint256 g0 = gasleft();
        _buyExactOut(hookedKey, 1 ether, p + _feeOnNet(p) + 1);
        uint256 hooked = g0 - gasleft();
        _cool();
        g0 = gasleft();
        _buyExactOut(refKey, 1 ether, p * 2);
        uint256 plain = g0 - gasleft();
        console2.log("BUY exactOut 1 WAR gas with hook   ", hooked);
        console2.log("BUY exactOut 1 WAR gas without hook", plain);

        _cool();
        g0 = gasleft();
        _sellExactOut(hookedKey, 0.5 ether);
        hooked = g0 - gasleft();
        _cool();
        g0 = gasleft();
        _sellExactOut(refKey, 0.5 ether);
        plain = g0 - gasleft();
        console2.log("SELL exactOut 0.5 ETH gas with hook   ", hooked);
        console2.log("SELL exactOut 0.5 ETH gas without hook", plain);
    }
}

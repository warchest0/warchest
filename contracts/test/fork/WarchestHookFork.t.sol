// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {WarchestHook} from "../../src/WarchestHook.sol";
import {DeployWarchestHook} from "../../script/DeployWarchestHook.s.sol";
import {WarchestHookFixture, MockVault} from "../utils/WarchestHookFixture.sol";

/// @notice Integration tests against the REAL Uniswap v4 PoolManager on a Robinhood Chain mainnet fork.
/// @dev Requires `ROBINHOOD_RPC_URL`; the whole suite is skipped when it is unset.
contract WarchestHookForkTest is WarchestHookFixture {
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    bool forked;
    MockVault vault;

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        // the public RPC is not archival: fork the latest block (the spike did the same)
        vm.createSelectFork(url);
        forked = true;

        manager = MANAGER;
        _deployRouters();
        vault = new MockVault();
        _deployWarchest(address(vault));
        _initPools(SQRT_PRICE_1_1);
        vm.deal(address(this), 1e24);
        _addLiquidityBoth(FULL_LOWER, FULL_UPPER, 10_000 ether, 20_000 ether);
    }

    function test_fork_realPoolManager() public onlyFork {
        assertEq(block.chainid, 4663);
        assertGt(address(MANAGER).code.length, 0);
        assertEq(address(hook.poolManager()), address(MANAGER));
    }

    /// @dev Cools every contract touched by a swap so that each measurement starts from a fresh-transaction state.
    function _cool() internal {
        vm.cool(address(manager));
        vm.cool(address(hook));
        vm.cool(address(token));
        vm.cool(address(swapRouter));
        vm.cool(address(vault));
    }

    function test_fork_buyExactIn() public onlyFork {
        uint256 x = 1 ether;
        uint256 fee = _feeOnGross(x);
        // warm-up swap so that the hook already holds claims (steady state: flush leaves 1 wei behind)
        _buyExactIn(hookedKey, 1);

        _cool();
        uint256 g0 = gasleft();
        BalanceDelta d = _buyExactIn(hookedKey, x);
        uint256 gasHooked = g0 - gasleft();
        assertEq(d.amount0(), -int256(x));
        assertEq(hook.pendingFees(), fee + 1);
        BalanceDelta r = _buyExactIn(refKey, x - fee);
        assertEq(d.amount1(), r.amount1());

        _cool();
        g0 = gasleft();
        _buyExactIn(refKey, x);
        uint256 gasRef = g0 - gasleft();
        console2.log("BUY exactIn 1 ETH  gas with hook   ", gasHooked);
        console2.log("BUY exactIn 1 ETH  gas without hook", gasRef);
        console2.log("BUY exactIn 1 ETH  hook overhead   ", gasHooked - gasRef);
    }

    function test_fork_sellExactIn() public onlyFork {
        uint256 t = 1 ether;
        BalanceDelta r = _sellExactIn(refKey, t);
        uint256 gross = uint256(int256(r.amount0()));
        uint256 fee = _feeOnGross(gross);
        _buyExactIn(hookedKey, 1); // warm-up: hook already holds claims (steady state)

        _cool();
        uint256 g0 = gasleft();
        BalanceDelta d = _sellExactIn(hookedKey, t);
        uint256 gasHooked = g0 - gasleft();
        assertEq(d.amount0(), int256(gross - fee));
        assertEq(hook.pendingFees(), fee + 1);

        _cool();
        g0 = gasleft();
        _sellExactIn(refKey, t);
        uint256 gasRef = g0 - gasleft();
        console2.log("SELL exactIn 1 WAR gas with hook   ", gasHooked);
        console2.log("SELL exactIn 1 WAR gas without hook", gasRef);
        console2.log("SELL exactIn 1 WAR hook overhead   ", gasHooked - gasRef);
    }

    function test_fork_flushToVault() public onlyFork {
        _buyExactIn(hookedKey, 1 ether);
        _sellExactIn(hookedKey, 1 ether);
        uint256 pending = hook.pendingFees();
        _cool();
        uint256 g0 = gasleft();
        hook.flush();
        console2.log("flush() gas", g0 - gasleft());
        assertEq(address(vault).balance, pending - 1);
        assertEq(hook.pendingFees(), 1);
    }

    /// @dev The deployment script against the real CREATE2 deployer proxy present on Robinhood Chain.
    function test_fork_deployScriptWithCreate2Deployer() public onlyFork {
        assertGt(CREATE2_DEPLOYER.code.length, 0, "CREATE2 deployer missing on chain");
        DeployWarchestHook script = new DeployWarchestHook();
        (address expected, bytes32 salt) = script.mine(MANAGER, address(token), address(vault), address(this));
        assertEq(uint160(expected) & Hooks.ALL_HOOK_MASK, HOOK_FLAGS);

        WarchestHook deployed = script.deploy(salt, MANAGER, address(token), address(vault), address(this));
        assertEq(address(deployed), expected);
        assertEq(uint160(address(deployed)) & Hooks.ALL_HOOK_MASK, HOOK_FLAGS);

        // the deployed hook is fully functional on the real PoolManager
        PoolKey memory k =
            PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), LP_FEE, TICK_SPACING, deployed);
        manager.initialize(k, SQRT_PRICE_1_1);
        _addLiquidity(k, FULL_LOWER, FULL_UPPER, 1_000 ether, 2_000 ether);
        _buyExactIn(k, 1 ether);
        assertEq(deployed.pendingFees(), 0.1 ether);

        // redeploying with the same salt fails (address taken) and mining again yields a fresh salt
        vm.expectRevert(DeployWarchestHook.Create2Failed.selector);
        script.deploy(salt, MANAGER, address(token), address(vault), address(this));
        (address expected2, bytes32 salt2) = script.mine(MANAGER, address(token), address(vault), address(this));
        assertTrue(salt2 != salt && expected2 != expected);
    }

    /// @dev `run()` end-to-end with environment variables, as S1.4 will invoke it.
    function test_fork_deployScriptRun() public onlyFork {
        vm.setEnv("POOL_MANAGER", vm.toString(address(MANAGER)));
        vm.setEnv("WARCHEST_TOKEN", vm.toString(address(token)));
        vm.setEnv("WARCHEST_VAULT", vm.toString(address(vault)));
        vm.setEnv("POOL_INITIALIZER", vm.toString(address(this)));
        DeployWarchestHook script = new DeployWarchestHook();
        WarchestHook deployed = script.run();
        assertEq(uint160(address(deployed)) & Hooks.ALL_HOOK_MASK, HOOK_FLAGS);
        assertEq(deployed.vault(), address(vault));
        assertEq(deployed.initializer(), address(this));
    }
}

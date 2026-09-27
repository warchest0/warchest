// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {WarchestHook} from "../../src/WarchestHook.sol";
import {DeployWarchest} from "../../script/DeployWarchest.s.sol";

/// @notice Runs the full launch script (S1.4) on Robinhood testnet and mainnet forks, then trades through the pool.
/// @dev Skipped when the corresponding RPC env var is unset.
contract DeployWarchestForkTest is Test, DeployWarchest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address constant VAULT = address(0x7A17);
    address deployer;

    function _fork(string memory envVar, uint256 chainId) internal returns (bool) {
        string memory url = vm.envOr(envVar, string(""));
        if (bytes(url).length == 0) return false;
        vm.createSelectFork(url);
        assertEq(block.chainid, chainId);
        return true;
    }

    function _launch() internal returns (Deployment memory d, Config memory cfg) {
        vm.setEnv("WARCHEST_VAULT", vm.toString(VAULT));
        vm.setEnv("LP_TOKEN_AMOUNT", vm.toString(uint256(500_000_000 ether)));
        vm.setEnv("LP_ETH_AMOUNT", vm.toString(uint256(10 ether)));
        cfg = this.loadConfig();
        deployer = makeAddr("deployer");
        vm.deal(deployer, 100 ether);
        // same semantics as `forge script --broadcast`: every call made by the script is sent by `deployer`
        vm.startBroadcast(deployer);
        d = launch(cfg, deployer);
        vm.stopBroadcast();
    }

    function _assertLaunched(Deployment memory d, Config memory cfg) internal {
        PoolId id = d.key.toId();
        (uint160 sqrtPrice,,,) = cfg.poolManager.getSlot0(id);
        assertEq(sqrtPrice, d.sqrtPriceX96);
        assertGt(cfg.poolManager.getLiquidity(id), 0);
        assertEq(PoolId.unwrap(d.hook.poolId()), PoolId.unwrap(id));
        assertEq(IERC721(address(cfg.positionManager)).ownerOf(d.positionId), deployer);
        assertEq(d.token.totalSupply(), cfg.supply);

        // buy through the pool: 10% of the ETH goes to the hook, then to the vault after flush
        PoolSwapTest router = new PoolSwapTest(cfg.poolManager);
        vm.deal(address(this), 1 ether);
        router.swap{value: 1 ether}(
            d.key, SwapParams(true, -1 ether, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), ""
        );
        assertGt(d.token.balanceOf(address(this)), 0);
        d.hook.flush();
        assertEq(VAULT.balance, 0.1 ether - 1); // 1 wei of claims is kept by design (see HOOK.md)
    }

    function test_launch_robinhoodTestnet() public {
        if (!_fork("ROBINHOOD_TESTNET_RPC_URL", 46630)) vm.skip(true);
        (Deployment memory d, Config memory cfg) = _launch();
        _assertLaunched(d, cfg);
    }

    function test_launch_robinhoodMainnet() public {
        if (!_fork("ROBINHOOD_RPC_URL", 4663)) vm.skip(true);
        (Deployment memory d, Config memory cfg) = _launch();
        _assertLaunched(d, cfg);
    }

    function test_sqrtPriceMatchesRatio() public pure {
        // 1 token per ETH -> price 1 -> 2^96
        assertEq(sqrtPriceX96For(1 ether, 1 ether), uint160(1 << 96));
        // 4 tokens per ETH -> sqrt(4) = 2
        assertEq(sqrtPriceX96For(4 ether, 1 ether), uint160(2 << 96));
    }

    receive() external payable {}
}

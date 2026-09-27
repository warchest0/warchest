// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {IUniswapV3PoolMinimal} from "../../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../../src/interfaces/external/IWETH9.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockUniswapV3Pool} from "../mocks/MockUniswapV3Pool.sol";

/// @notice Vault deployed on mocked venue contracts. `TICK` is the live tick of the real pool on 2026-09-27
///         (≈ 2 695 USDG per ETH), so numbers in tests look like production numbers.
abstract contract VaultFixture is Test {
    uint32 constant TWAP_WINDOW = 30 minutes;
    uint16 constant MAX_SLIPPAGE_BPS = 100; // 1%
    uint256 constant MAX_CONVERT = 50 ether;
    uint64 constant COOLDOWN = 10 minutes;
    int24 constant TICK = -197308;
    uint16 constant BPS = 10_000;

    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address attacker = makeAddr("attacker");

    MockWETH weth;
    MockUSDG usdg;
    MockUniswapV3Pool pool;
    WarchestVault vault;

    function _venue() internal view returns (WarchestVault.Venue memory) {
        return WarchestVault.Venue({
            pool: IUniswapV3PoolMinimal(address(pool)), weth: IWETH9(address(weth)), usdg: IERC20(address(usdg))
        });
    }

    function _conversionParams() internal pure returns (WarchestVault.ConversionParams memory) {
        return WarchestVault.ConversionParams({
            twapWindow: TWAP_WINDOW,
            maxSlippageBps: MAX_SLIPPAGE_BPS,
            maxConvertPerCall: MAX_CONVERT,
            convertCooldown: COOLDOWN
        });
    }

    function _deployVenue() internal {
        vm.warp(1_800_000_000);
        weth = new MockWETH();
        usdg = new MockUSDG();
        pool = new MockUniswapV3Pool(address(weth), address(usdg));
        pool.setTicks(TICK);
        usdg.mint(address(pool), 1e12 * 1e6); // 1 T USDG of mock depth
    }

    function _deployVault() internal {
        _deployVenue();
        vault = new WarchestVault(guardian, keeper, _venue(), _conversionParams());
    }

    /// Sends `amount` wei to the vault from `from` (plain transfer, like the hook's flush).
    function _fund(address from, uint256 amount) internal {
        vm.deal(from, from.balance + amount);
        vm.prank(from);
        (bool ok,) = address(vault).call{value: amount}("");
        assertTrue(ok, "fund failed");
    }

    function _convert(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        vm.prank(keeper);
        return vault.convertEthToUsdg(amountIn, minOut);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {IWarchestDecisionSource} from "../../src/interfaces/IWarchestDecisionSource.sol";
import {IUniswapV3PoolMinimal} from "../../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../../src/interfaces/external/IWETH9.sol";
import {IAcrossSpokePool} from "../../src/interfaces/external/IAcrossSpokePool.sol";
import {MockAcrossSpokePool} from "../../src/mocks/MockAcrossSpokePool.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockUniswapV3Pool} from "../mocks/MockUniswapV3Pool.sol";
import {MockDecisionSource} from "../mocks/MockDecisionSource.sol";

/// @notice Vault deployed on mocked venue, bridge and governance. `TICK` is the live tick of the real pool on
///         2026-09-27 (≈ 2 700 USDG per ETH), so numbers in tests look like production numbers.
abstract contract VaultFixture is Test {
    uint32 constant TWAP_WINDOW = 30 minutes;
    uint16 constant MAX_SLIPPAGE_BPS = 100; // 1%
    uint256 constant MAX_CONVERT = 50 ether;
    uint64 constant COOLDOWN = 10 minutes;
    int24 constant TICK = -197308;
    uint16 constant BPS = 10_000;

    uint16 constant CAP_BPS = 2_000; // 20%
    uint16 constant MAX_BRIDGE_FEE_BPS = 50; // 0.5%
    uint64 constant MAX_DECISION_AGE = 3 days;
    uint16 constant STOP_LOSS_BPS = 500;
    uint8 constant LEVERAGE = 3;
    uint16 constant TAKE_PROFIT_BPS = 1_000;
    uint256 constant DEST_CHAIN = 999;
    uint32 constant FILL_WINDOW = 4 hours;
    uint64 constant REPORT_WINDOW = 6 hours;

    uint32 constant BTC = 0;
    uint32 constant ETH_ASSET = 1;

    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address attacker = makeAddr("attacker");
    address hlAccount = makeAddr("hlAccount");
    address usdcHyperEvm = makeAddr("usdcHyperEvm");
    address distributor = makeAddr("distributor");

    MockWETH weth;
    MockUSDG usdg;
    MockUniswapV3Pool pool;
    MockAcrossSpokePool spoke;
    MockDecisionSource gov;
    WarchestVault vault;

    function _venue() internal view returns (WarchestVault.Venue memory) {
        return WarchestVault.Venue({
            pool: IUniswapV3PoolMinimal(address(pool)), weth: IWETH9(address(weth)), usdg: IERC20(address(usdg))
        });
    }

    function _bridge() internal view returns (WarchestVault.Bridge memory) {
        return WarchestVault.Bridge({
            spokePool: IAcrossSpokePool(address(spoke)),
            recipient: hlAccount,
            outputToken: usdcHyperEvm,
            destinationChainId: DEST_CHAIN
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

    function _orderParams() internal pure returns (WarchestVault.OrderParams memory) {
        return WarchestVault.OrderParams({
            capBps: CAP_BPS,
            maxBridgeFeeBps: MAX_BRIDGE_FEE_BPS,
            maxDecisionAge: MAX_DECISION_AGE,
            stopLossBps: STOP_LOSS_BPS,
            leverage: LEVERAGE,
            takeProfitBps: TAKE_PROFIT_BPS,
            reportChallengeWindow: REPORT_WINDOW
        });
    }

    function _deployVenue() internal {
        vm.warp(1_800_000_000);
        weth = new MockWETH();
        usdg = new MockUSDG();
        pool = new MockUniswapV3Pool(address(weth), address(usdg));
        pool.setTicks(TICK);
        usdg.mint(address(pool), 1e12 * 1e6); // 1 T USDG of mock depth
        spoke = new MockAcrossSpokePool();
        gov = new MockDecisionSource();
    }

    function _newVault(
        address guardian_,
        address keeper_,
        WarchestVault.Venue memory venue,
        WarchestVault.ConversionParams memory cp
    ) internal returns (WarchestVault) {
        return new WarchestVault(
            guardian_, keeper_, IWarchestDecisionSource(address(gov)), distributor, venue, _bridge(), cp, _orderParams()
        );
    }

    function _deployVault() internal {
        _deployVenue();
        vault = _newVault(guardian, keeper, _venue(), _conversionParams());
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

    /// Keeper executes the current decision with a fee of exactly `MAX_BRIDGE_FEE_BPS`.
    function _execute(uint256 amount) internal {
        vm.prank(keeper);
        vault.executeDecision(
            amount,
            amount * (BPS - MAX_BRIDGE_FEE_BPS) / BPS,
            uint32(vm.getBlockTimestamp()),
            uint32(vm.getBlockTimestamp()) + FILL_WINDOW
        );
    }

    /// Funds 100 ETH, converts 50 ETH, mints decision 1 (BTC long), executes the max order and lets the position
    /// reach the minimum age (`reportChallengeWindow`) after which the keeper may close it on its own.
    function _openPosition() internal returns (uint256 decisionId, uint256 capital) {
        _fund(attacker, 100 ether);
        _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        decisionId = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        capital = vault.maxOrderAmount();
        _execute(capital);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
    }
}

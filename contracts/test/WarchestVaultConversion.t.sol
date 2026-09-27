// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {WarchestVault} from "../src/WarchestVault.sol";
import {IUniswapV3PoolMinimal} from "../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../src/interfaces/external/IWETH9.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";

/// @notice S3.1: custody, roles, TWAP-guarded ETH → USDG conversion and NAV, on mocked venue contracts.
contract WarchestVaultConversionTest is VaultFixture {
    event EthReceived(address indexed from, uint256 amount);
    event EthConverted(uint256 ethIn, uint256 usdgOut, uint256 twapFloor);
    event KeeperChanged(address indexed previous, address indexed current);
    event Paused(bool paused);

    function setUp() public {
        _deployVault();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    function test_constructor_setsImmutablesAndRoles() public view {
        assertEq(vault.guardian(), guardian);
        assertEq(vault.keeper(), keeper);
        assertEq(address(vault.pool()), address(pool));
        assertEq(address(vault.weth()), address(weth));
        assertEq(address(vault.usdg()), address(usdg));
        assertEq(vault.twapWindow(), TWAP_WINDOW);
        assertEq(vault.maxSlippageBps(), MAX_SLIPPAGE_BPS);
        assertEq(vault.maxConvertPerCall(), MAX_CONVERT);
        assertEq(vault.convertCooldown(), COOLDOWN);
        assertFalse(vault.paused());
        assertEq(vault.usdgLedger(), 0);
    }

    function test_constructor_revertsZeroAddresses() public {
        WarchestVault.Venue memory v = _venue();
        WarchestVault.ConversionParams memory p = _conversionParams();
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        _newVault(address(0), keeper, v, p);
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        _newVault(guardian, address(0), v, p);

        WarchestVault.Venue memory bad = v;
        bad.pool = IUniswapV3PoolMinimal(address(0));
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        _newVault(guardian, keeper, bad, p);
        bad = v;
        bad.weth = IWETH9(address(0));
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        _newVault(guardian, keeper, bad, p);
        bad = v;
        bad.usdg = IERC20(address(0));
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        _newVault(guardian, keeper, bad, p);
    }

    function test_constructor_revertsPoolMismatch() public {
        MockUniswapV3Pool flipped = new MockUniswapV3Pool(address(usdg), address(weth));
        WarchestVault.Venue memory v = _venue();
        v.pool = IUniswapV3PoolMinimal(address(flipped));
        vm.expectRevert(WarchestVault.PoolMismatch.selector);
        _newVault(guardian, keeper, v, _conversionParams());

        MockUniswapV3Pool other = new MockUniswapV3Pool(address(weth), address(0xBEEF));
        v.pool = IUniswapV3PoolMinimal(address(other));
        vm.expectRevert(WarchestVault.PoolMismatch.selector);
        _newVault(guardian, keeper, v, _conversionParams());
    }

    function test_constructor_revertsInvalidParams() public {
        WarchestVault.ConversionParams memory p = _conversionParams();
        p.twapWindow = 0;
        vm.expectRevert(WarchestVault.InvalidParams.selector);
        _newVault(guardian, keeper, _venue(), p);

        p = _conversionParams();
        p.maxSlippageBps = 0;
        vm.expectRevert(WarchestVault.InvalidParams.selector);
        _newVault(guardian, keeper, _venue(), p);

        p = _conversionParams();
        p.maxSlippageBps = 1001;
        vm.expectRevert(WarchestVault.InvalidParams.selector);
        _newVault(guardian, keeper, _venue(), p);

        p = _conversionParams();
        p.maxConvertPerCall = 0;
        vm.expectRevert(WarchestVault.InvalidParams.selector);
        _newVault(guardian, keeper, _venue(), p);

        // cooldown 0 is allowed
        p = _conversionParams();
        p.convertCooldown = 0;
        _newVault(guardian, keeper, _venue(), p);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Custody
    // ---------------------------------------------------------------------------------------------------------------

    function test_receive_fromAnyoneEmits() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit EthReceived(attacker, 3 ether);
        _fund(attacker, 3 ether);
        assertEq(address(vault).balance, 3 ether);
    }

    function test_receive_whenPaused() public {
        vm.prank(guardian);
        vault.setPaused(true);
        _fund(attacker, 1 ether);
        assertEq(address(vault).balance, 1 ether);
    }

    function testFuzz_receive_neverReverts(address from, uint96 amount, bool pausedState) public {
        vm.assume(from != address(vault));
        vm.prank(guardian);
        vault.setPaused(pausedState);
        vm.deal(from, amount);
        vm.prank(from);
        (bool ok,) = address(vault).call{value: amount}("");
        assertTrue(ok);
        assertEq(address(vault).balance, amount);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Conversion: happy paths
    // ---------------------------------------------------------------------------------------------------------------

    function test_convert_happyPath() public {
        _fund(attacker, 10 ether);
        uint256 floor = vault.twapFloor(1 ether);
        uint256 expected = pool.quote(TICK, 1 ether);
        assertGt(expected, floor);

        vm.expectEmit(false, false, false, true, address(vault));
        emit EthConverted(1 ether, expected, floor);
        uint256 out = _convert(1 ether, floor);

        assertEq(out, expected);
        assertEq(address(vault).balance, 9 ether);
        assertEq(usdg.balanceOf(address(vault)), out);
        assertEq(vault.usdgLedger(), out);
        assertEq(weth.balanceOf(address(vault)), 0, "no WETH left behind");
        assertEq(weth.balanceOf(address(pool)), 1 ether);
        assertEq(vault.lastConvertAt(), block.timestamp);
    }

    function test_convert_atMaxPerCall() public {
        _fund(attacker, MAX_CONVERT);
        uint256 out = _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        assertEq(out, pool.quote(TICK, MAX_CONVERT));
        assertEq(address(vault).balance, 0);
    }

    function test_convert_keeperMayBeStricterThanFloor() public {
        _fund(attacker, 1 ether);
        uint256 quote = pool.quote(TICK, 1 ether);
        // minOut exactly at the achievable price passes
        assertEq(_convert(1 ether, quote), quote);
    }

    function test_convert_afterCooldown() public {
        _fund(attacker, 2 ether);
        _convert(1 ether, vault.twapFloor(1 ether));
        vm.warp(block.timestamp + COOLDOWN);
        _convert(1 ether, vault.twapFloor(1 ether));
        assertEq(address(vault).balance, 0);
        assertEq(vault.usdgLedger(), usdg.balanceOf(address(vault)));
    }

    function test_convert_acceptsPriceWithinBand() public {
        _fund(attacker, 1 ether);
        pool.setExecTick(TICK - 50); // spot ≈ 0.5% below the TWAP
        uint256 floor = vault.twapFloor(1 ether);
        uint256 out = _convert(1 ether, floor);
        assertGe(out, floor);
        assertLt(out, pool.quote(TICK, 1 ether));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Conversion: reverts
    // ---------------------------------------------------------------------------------------------------------------

    function test_convert_revertsNotKeeper() public {
        _fund(attacker, 1 ether);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(1 ether, floor);
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(1 ether, floor);
    }

    function test_convert_revertsWhenPaused() public {
        _fund(attacker, 1 ether);
        vm.prank(guardian);
        vault.setPaused(true);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.IsPaused.selector);
        vault.convertEthToUsdg(1 ether, floor);
    }

    function test_convert_revertsAmountOutOfRange() public {
        _fund(attacker, 100 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.AmountOutOfRange.selector, 0, MAX_CONVERT));
        vault.convertEthToUsdg(0, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.AmountOutOfRange.selector, MAX_CONVERT + 1, MAX_CONVERT));
        vault.convertEthToUsdg(MAX_CONVERT + 1, 0);
    }

    function test_convert_revertsInsufficientEth() public {
        _fund(attacker, 1 ether);
        uint256 floor = vault.twapFloor(2 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.InsufficientEth.selector, 2 ether, 1 ether));
        vault.convertEthToUsdg(2 ether, floor);
    }

    function test_convert_revertsCooldown() public {
        _fund(attacker, 2 ether);
        _convert(1 ether, vault.twapFloor(1 ether));
        uint256 nextAllowed = block.timestamp + COOLDOWN;
        vm.warp(nextAllowed - 1);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ConvertCooldown.selector, nextAllowed));
        vault.convertEthToUsdg(1 ether, floor);
    }

    function test_convert_revertsMinOutBelowFloor() public {
        _fund(attacker, 1 ether);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.MinOutBelowFloor.selector, floor - 1, floor));
        vault.convertEthToUsdg(1 ether, floor - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.MinOutBelowFloor.selector, 0, floor));
        vault.convertEthToUsdg(1 ether, 0);
    }

    /// The pool fills 1.5% below the TWAP (sandwich / manipulated spot): the floor computed from the oracle rejects it.
    function test_convert_revertsWhenSpotSandwiched() public {
        _fund(attacker, 1 ether);
        pool.setExecTick(TICK - 150);
        uint256 floor = vault.twapFloor(1 ether);
        uint256 wouldGet = pool.quote(TICK - 150, 1 ether);
        assertLt(wouldGet, floor);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.InsufficientOutput.selector, wouldGet, floor));
        vault.convertEthToUsdg(1 ether, floor);
        // nothing moved
        assertEq(address(vault).balance, 1 ether);
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(weth.balanceOf(address(vault)), 0);
        assertEq(vault.usdgLedger(), 0);
        assertEq(vault.lastConvertAt(), 0);
    }

    function test_convert_revertsPartialFill() public {
        _fund(attacker, 1 ether);
        // 90% fill at a price good enough that minOut is still met: the partial-fill check must catch it
        pool.setFillBps(9_000);
        pool.setExecTick(TICK + 2_000);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PartialFill.selector, 0.9 ether, 1 ether));
        vault.convertEthToUsdg(1 ether, floor);
    }

    function test_convert_revertsWhenOracleHistoryTooShort() public {
        _fund(attacker, 1 ether);
        pool.setObserveReverts(true);
        vm.prank(keeper);
        vm.expectRevert(bytes("OLD"));
        vault.convertEthToUsdg(1 ether, 0);
        vm.expectRevert(bytes("OLD"));
        vault.nav();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Swap callback hardening
    // ---------------------------------------------------------------------------------------------------------------

    function test_callback_revertsFromNonPool() public {
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.UnexpectedCallback.selector);
        vault.uniswapV3SwapCallback(1, 0, "");
    }

    function test_callback_revertsFromPoolOutsideSwap() public {
        deal(address(weth), address(vault), 5 ether);
        vm.expectRevert(WarchestVault.UnexpectedCallback.selector);
        pool.pokeCallback(address(vault), 1 ether);
        assertEq(weth.balanceOf(address(vault)), 5 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Oracle math
    // ---------------------------------------------------------------------------------------------------------------

    function test_twapTick_matchesMock() public view {
        assertEq(vault.twapTick(), TICK);
    }

    function test_twapTick_roundsTowardNegativeInfinity() public {
        int56 w = int56(uint56(TWAP_WINDOW));
        pool.setRawCumulatives(0, -1);
        assertEq(vault.twapTick(), -1);
        pool.setRawCumulatives(0, -w);
        assertEq(vault.twapTick(), -1);
        pool.setRawCumulatives(0, -w - 1);
        assertEq(vault.twapTick(), -2);
        pool.setRawCumulatives(0, w + 1);
        assertEq(vault.twapTick(), 1);
        pool.setRawCumulatives(0, w - 1);
        assertEq(vault.twapTick(), 0);
        pool.setRawCumulatives(-5 * w, -5 * w - 7); // negative running total, still delta = -7
        assertEq(vault.twapTick(), -1);
    }

    /// 1.0001^-197308 × 1e12 = 2 700.54 USDG per ETH (RESEARCH.md §3.3 measured 2 693 net of fee and impact).
    function test_quote_sanityAgainstLiveResearch() public view {
        uint256 q = vault.quoteAtTick(TICK, 1 ether);
        assertGt(q, 2_700e6);
        assertLt(q, 2_701e6);
        assertEq(vault.quoteEthInUsdg(1 ether), q);
        assertEq(vault.twapFloor(1 ether), q * (BPS - MAX_SLIPPAGE_BPS) / BPS);
    }

    function test_quote_tickZeroIsParity() public view {
        assertEq(vault.quoteAtTick(0, 1e18), 1e18);
        assertEq(vault.quoteAtTick(0, 12345), 12345);
    }

    function test_quote_highTickBranch() public view {
        // sqrtPrice > uint128.max above tick ≈ 443 636: the ratioX128 branch must agree with the mock's copy and
        // stay monotonic across the branch boundary
        int24 hi = 500_000;
        assertGt(uint256(TickMath.getSqrtPriceAtTick(hi)), uint256(type(uint128).max));
        assertEq(vault.quoteAtTick(hi, 1e6), pool.quote(hi, 1e6));
        assertGt(vault.quoteAtTick(hi, 1e6), vault.quoteAtTick(443_000, 1e6));
        assertGt(vault.quoteAtTick(TickMath.MAX_TICK, 1), 0);
    }

    function testFuzz_quote_monotonicInTick(int24 a, int24 b) public view {
        a = int24(bound(a, TickMath.MIN_TICK, TickMath.MAX_TICK));
        b = int24(bound(b, TickMath.MIN_TICK, TickMath.MAX_TICK));
        if (a > b) (a, b) = (b, a);
        assertLe(vault.quoteAtTick(a, 1e18), vault.quoteAtTick(b, 1e18));
    }

    function testFuzz_quote_linearInAmount(uint96 amount) public view {
        uint256 one = vault.quoteAtTick(TICK, amount);
        uint256 two = vault.quoteAtTick(TICK, uint256(amount) * 2);
        assertGe(two, 2 * one);
        assertLe(two, 2 * one + 1);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // NAV
    // ---------------------------------------------------------------------------------------------------------------

    function test_nav_zero() public view {
        assertEq(vault.nav(), 0);
    }

    function test_nav_countsUsdgAtFaceAndEthAtFloor() public {
        _fund(attacker, 10 ether);
        usdg.mint(address(vault), 1_000e6);
        assertEq(vault.nav(), 1_000e6 + vault.twapFloor(10 ether));
        assertLt(vault.nav(), 1_000e6 + vault.quoteEthInUsdg(10 ether));
    }

    function test_nav_afterConversionIsAtLeastPreConversionFloor() public {
        _fund(attacker, 10 ether);
        uint256 navBefore = vault.nav();
        _convert(10 ether, vault.twapFloor(10 ether));
        assertGe(vault.nav(), navBefore);
    }

    function testFuzz_nav_isConservative(uint96 ethAmount, uint96 usdgAmount) public {
        _fund(attacker, ethAmount);
        usdg.mint(address(vault), usdgAmount);
        uint256 twapValue = vault.quoteEthInUsdg(ethAmount);
        uint256 n = vault.nav();
        assertLe(n, uint256(usdgAmount) + twapValue);
        assertGe(n + 1, uint256(usdgAmount) + twapValue * (BPS - MAX_SLIPPAGE_BPS) / BPS);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Malicious keeper
    // ---------------------------------------------------------------------------------------------------------------

    /// Whatever `minOut` and whatever the spot price, a conversion either reverts or delivers ≥ the TWAP floor.
    function testFuzz_maliciousKeeper_cannotSellBelowFloor(uint256 amountIn, int24 execOffset, uint256 minOut) public {
        amountIn = bound(amountIn, 1, MAX_CONVERT);
        execOffset = int24(bound(execOffset, -2_000, 2_000));
        pool.setExecTick(TICK + execOffset);
        _fund(attacker, amountIn);
        uint256 floor = vault.twapFloor(amountIn);
        minOut = bound(minOut, 0, 2 * vault.quoteEthInUsdg(amountIn) + 1);
        uint256 wouldGet = pool.quote(TICK + execOffset, amountIn);

        vm.prank(keeper);
        if (minOut < floor) {
            vm.expectRevert(abi.encodeWithSelector(WarchestVault.MinOutBelowFloor.selector, minOut, floor));
            vault.convertEthToUsdg(amountIn, minOut);
        } else if (wouldGet < minOut) {
            vm.expectRevert(abi.encodeWithSelector(WarchestVault.InsufficientOutput.selector, wouldGet, minOut));
            vault.convertEthToUsdg(amountIn, minOut);
        } else {
            uint256 out = vault.convertEthToUsdg(amountIn, minOut);
            assertGe(out, floor);
            assertEq(usdg.balanceOf(address(vault)), out);
        }
    }

    /// Repeated worst-case conversions (spot pinned ~1% under the TWAP) lose at most maxSlippageBps in total.
    function test_maliciousKeeper_repeatedConversions_lossBounded() public {
        _fund(attacker, 10 * MAX_CONVERT);
        pool.setExecTick(TICK - 100); // 1.0001^-100 ≈ −0.995%, just inside the band
        uint256 total;
        for (uint256 i; i < 10; ++i) {
            vm.warp(block.timestamp + COOLDOWN);
            total += _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        }
        assertEq(address(vault).balance, 0);
        uint256 twapValue = vault.quoteEthInUsdg(10 * MAX_CONVERT);
        assertGe(total, twapValue * (BPS - MAX_SLIPPAGE_BPS) / BPS);
        assertEq(usdg.balanceOf(address(vault)), total);
        assertEq(vault.usdgLedger(), total);
    }

    /// The cooldown caps how fast a compromised keeper can convert, so the guardian can pause in time.
    function test_maliciousKeeper_rateLimitedThenPaused() public {
        _fund(attacker, 3 * MAX_CONVERT);
        uint256 floor = vault.twapFloor(MAX_CONVERT);
        _convert(MAX_CONVERT, floor);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.ConvertCooldown.selector, block.timestamp + COOLDOWN));
        vault.convertEthToUsdg(MAX_CONVERT, floor);
        vm.prank(guardian);
        vault.setPaused(true);
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.IsPaused.selector);
        vault.convertEthToUsdg(MAX_CONVERT, floor);
        assertEq(address(vault).balance, 2 * MAX_CONVERT);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------------------------------------------------

    function test_setKeeper_onlyGuardian() public {
        address newKeeper = makeAddr("newKeeper");
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.setKeeper(newKeeper);
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        vault.setKeeper(address(0));

        vm.expectEmit(true, true, false, true, address(vault));
        emit KeeperChanged(keeper, newKeeper);
        vm.prank(guardian);
        vault.setKeeper(newKeeper);
        assertEq(vault.keeper(), newKeeper);

        _fund(attacker, 1 ether);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(1 ether, floor);
        vm.prank(newKeeper);
        vault.convertEthToUsdg(1 ether, floor);
    }

    function test_transferGuardian_twoStep() public {
        address next = makeAddr("nextGuardian");
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.transferGuardian(next);

        vm.prank(guardian);
        vault.transferGuardian(next);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.pendingGuardian(), next);

        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotPendingGuardian.selector);
        vault.acceptGuardian();

        vm.prank(next);
        vault.acceptGuardian();
        assertEq(vault.guardian(), next);
        assertEq(vault.pendingGuardian(), address(0));

        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.setPaused(true);
    }

    function test_setPaused_onlyGuardian() public {
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.setPaused(true);
        vm.expectEmit(false, false, false, true, address(vault));
        emit Paused(true);
        vm.prank(guardian);
        vault.setPaused(true);
        assertTrue(vault.paused());
        vm.prank(guardian);
        vault.setPaused(false);
        assertFalse(vault.paused());
    }
}

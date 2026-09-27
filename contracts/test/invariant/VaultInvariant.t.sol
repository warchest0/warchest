// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockUniswapV3Pool} from "../mocks/MockUniswapV3Pool.sol";
import {VaultFixture} from "../utils/VaultFixture.sol";

/// @notice Random ETH inflows, price moves (spot and TWAP), keeper conversions with random minOut, pauses and
///         non-keeper attempts.
contract VaultHandler is Test {
    WarchestVault vault;
    MockUniswapV3Pool pool;
    MockWETH weth;
    MockUSDG usdg;
    address keeper;
    address guardian;
    address attacker;
    int24 baseTick;

    uint256 public ethFunded;
    uint256 public ethSpent;
    uint256 public usdgOut;
    uint256 public floorSum;
    uint256 public conversions;
    uint256 public rejected;

    constructor(
        WarchestVault vault_,
        MockUniswapV3Pool pool_,
        MockWETH weth_,
        MockUSDG usdg_,
        address keeper_,
        address guardian_,
        address attacker_,
        int24 baseTick_
    ) {
        vault = vault_;
        pool = pool_;
        weth = weth_;
        usdg = usdg_;
        keeper = keeper_;
        guardian = guardian_;
        attacker = attacker_;
        baseTick = baseTick_;
    }

    function fund(uint256 seed, uint96 amount) external {
        address from = address(uint160(uint256(keccak256(abi.encode("funder", seed % 5)))));
        vm.deal(from, amount);
        vm.prank(from);
        (bool ok,) = address(vault).call{value: amount}("");
        require(ok, "receive reverted");
        ethFunded += amount;
    }

    function moveSpot(int24 offset) external {
        pool.setExecTick(baseTick + int24(bound(offset, -3_000, 3_000)));
    }

    function moveTwap(int24 offset) external {
        pool.setTwapTick(baseTick + int24(bound(offset, -500, 500)));
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 0, 1 hours));
    }

    function pause(bool p) external {
        vm.prank(guardian);
        vault.setPaused(p);
    }

    function convert(uint256 amountIn, uint256 minOutBps) external {
        amountIn = bound(amountIn, 0, 2 * vault.maxConvertPerCall());
        uint256 floor = vault.twapFloor(amountIn);
        uint256 minOut = floor * bound(minOutBps, 9_000, 11_000) / 10_000;
        vm.prank(keeper);
        try vault.convertEthToUsdg(amountIn, minOut) returns (uint256 out) {
            ethSpent += amountIn;
            usdgOut += out;
            floorSum += floor;
            conversions++;
            assertGe(out, floor);
            assertGe(out, minOut);
        } catch {
            rejected++;
        }
    }

    function attackerConvert(uint256 amountIn) external {
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(amountIn, 0);
    }

    function guardianConvert(uint256 amountIn) external {
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(amountIn, 0);
    }
}

contract VaultInvariantTest is VaultFixture {
    VaultHandler handler;

    function setUp() public {
        _deployVault();
        handler = new VaultHandler(vault, pool, weth, usdg, keeper, guardian, attacker, TICK);
        targetContract(address(handler));
    }

    /// ETH only ever leaves the vault through a conversion, and exactly the converted amount.
    function invariant_ethConservation() public view {
        assertEq(address(vault).balance, handler.ethFunded() - handler.ethSpent());
        assertEq(weth.balanceOf(address(pool)), handler.ethSpent());
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    /// Every USDG in the vault came from a conversion and is accounted in the ledger.
    function invariant_usdgLedgerMatchesBalance() public view {
        assertEq(usdg.balanceOf(address(vault)), handler.usdgOut());
        assertEq(vault.usdgLedger(), handler.usdgOut());
    }

    /// Σ received ≥ Σ TWAP floors: the treasury never sold below TWAP × (1 − maxSlippageBps).
    function invariant_neverSoldBelowFloor() public view {
        assertGe(handler.usdgOut(), handler.floorSum());
    }

    /// No value ever reaches the keeper, the guardian or an attacker.
    function invariant_rolesHoldNothing() public view {
        assertEq(keeper.balance, 0);
        assertEq(guardian.balance, 0);
        assertEq(attacker.balance, 0);
        assertEq(usdg.balanceOf(keeper), 0);
        assertEq(usdg.balanceOf(guardian), 0);
        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(weth.balanceOf(keeper), 0);
        assertEq(weth.balanceOf(guardian), 0);
        assertEq(weth.balanceOf(attacker), 0);
    }

    /// Roles are never changed by the handler; nobody else can.
    function invariant_rolesStable() public view {
        assertEq(vault.keeper(), keeper);
        assertEq(vault.guardian(), guardian);
    }
}

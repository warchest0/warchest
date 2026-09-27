// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {IWarchestDecisionSource} from "../../src/interfaces/IWarchestDecisionSource.sol";
import {IAcrossSpokePool} from "../../src/interfaces/external/IAcrossSpokePool.sol";
import {MockAcrossSpokePool} from "../../src/mocks/MockAcrossSpokePool.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockUniswapV3Pool} from "../mocks/MockUniswapV3Pool.sol";
import {MockDecisionSource} from "../mocks/MockDecisionSource.sol";
import {VaultFixture} from "../utils/VaultFixture.sol";

/// @notice Random ETH inflows, price moves (spot and TWAP), governance decisions and close requests, keeper
///         conversions and orders with random parameters, pauses and non-keeper attempts.
contract VaultHandler is Test {
    WarchestVault vault;
    MockUniswapV3Pool pool;
    MockWETH weth;
    MockUSDG usdg;
    MockAcrossSpokePool spoke;
    MockDecisionSource gov;
    address keeper;
    address guardian;
    address attacker;
    address hlAccount;
    int24 baseTick;

    uint256 public ethFunded;
    uint256 public ethSpent;
    uint256 public usdgOut;
    uint256 public floorSum;
    uint256 public conversions;
    uint256 public bridged;
    uint256 public executions;
    bool public capViolated;
    bool public recipientViolated;
    bool public doubleExecution;
    mapping(uint256 decisionId => uint256 count) public executionsOf;

    constructor(
        WarchestVault vault_,
        MockUniswapV3Pool pool_,
        MockWETH weth_,
        MockUSDG usdg_,
        MockAcrossSpokePool spoke_,
        MockDecisionSource gov_,
        address keeper_,
        address guardian_,
        address attacker_,
        address hlAccount_,
        int24 baseTick_
    ) {
        vault = vault_;
        pool = pool_;
        weth = weth_;
        usdg = usdg_;
        spoke = spoke_;
        gov = gov_;
        keeper = keeper_;
        guardian = guardian_;
        attacker = attacker_;
        hlAccount = hlAccount_;
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

    function decide(uint32 asset, uint8 side) external {
        gov.nextDecision(asset % 3, IWarchestDecisionSource.Side(side % 2));
    }

    function requestClose() external {
        uint256 id = gov.currentDecision().id;
        if (id != 0) gov.setCloseRequested(id, true);
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
        } catch {}
    }

    function execute(uint256 amount, uint256 outBps, uint32 quoteAgo, uint32 fillIn) external {
        uint256 navBefore = vault.nav();
        uint256 cap = navBefore * vault.capBps() / 10_000;
        amount = bound(amount, 0, 2 * cap + 1);
        uint256 outputAmount = amount * bound(outBps, 9_900, 10_050) / 10_000;
        uint32 quoteTs = uint32(block.timestamp) - uint32(bound(quoteAgo, 0, 4_000));
        uint32 fillDeadline = uint32(block.timestamp) + uint32(bound(fillIn, 0, 30_000));
        uint256 id = gov.currentDecision().id;

        vm.recordLogs();
        vm.prank(keeper);
        try vault.executeDecision(amount, outputAmount, quoteTs, fillDeadline) {
            executions++;
            bridged += amount;
            if (amount * 10_000 > navBefore * vault.capBps()) capViolated = true;
            if (++executionsOf[id] > 1) doubleExecution = true;
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == address(spoke) && logs[i].topics[0] == IAcrossSpokePool.FundsDeposited.selector)
                {
                    bytes memory data = logs[i].data;
                    bytes32 recipient;
                    assembly ("memory-safe") {
                        recipient := mload(add(data, 0x100)) // word 7 of the non-indexed fields
                    }
                    if (recipient != bytes32(uint256(uint160(hlAccount)))) recipientViolated = true;
                }
            }
        } catch {}
    }

    function attackerCalls(uint256 amountIn) external {
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(amountIn, 0);
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(amountIn, amountIn, uint32(block.timestamp), uint32(block.timestamp) + 1 hours);
    }

    function guardianCalls(uint256 amountIn) external {
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(amountIn, 0);
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(amountIn, amountIn, uint32(block.timestamp), uint32(block.timestamp) + 1 hours);
    }
}

contract VaultInvariantTest is VaultFixture {
    VaultHandler handler;

    function setUp() public {
        _deployVault();
        handler = new VaultHandler(vault, pool, weth, usdg, spoke, gov, keeper, guardian, attacker, hlAccount, TICK);
        targetContract(address(handler));
    }

    /// ETH only ever leaves the vault through a conversion, and exactly the converted amount.
    function invariant_ethConservation() public view {
        assertEq(address(vault).balance, handler.ethFunded() - handler.ethSpent());
        assertEq(weth.balanceOf(address(pool)), handler.ethSpent());
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    /// USDG is either in the vault or in the SpokePool (bridged for the immutable recipient); the ledger tracks
    /// the vault's balance exactly (no external USDG inflow in this model).
    function invariant_usdgConservation() public view {
        assertEq(usdg.balanceOf(address(vault)) + usdg.balanceOf(address(spoke)), handler.usdgOut());
        assertEq(usdg.balanceOf(address(spoke)), handler.bridged());
        assertEq(vault.usdgLedger(), usdg.balanceOf(address(vault)));
        assertEq(usdg.allowance(address(vault), address(spoke)), 0);
    }

    /// Σ received ≥ Σ TWAP floors: the treasury never sold below TWAP × (1 − maxSlippageBps).
    function invariant_neverSoldBelowFloor() public view {
        assertGe(handler.usdgOut(), handler.floorSum());
    }

    /// Every order was ≤ 20% of the NAV at execution time, for the immutable recipient, once per decision.
    function invariant_orderBounds() public view {
        assertFalse(handler.capViolated());
        assertFalse(handler.recipientViolated());
        assertFalse(handler.doubleExecution());
        assertLe(handler.executions(), 1); // no close path yet (S3.3): at most one position ever
    }

    /// An open position always matches the last executed decision and the SpokePool holds its capital.
    function invariant_positionConsistent() public view {
        WarchestVault.Position memory p = vault.position();
        if (p.decisionId != 0) {
            assertEq(p.decisionId, vault.lastExecutedDecisionId());
            assertEq(p.capital, handler.bridged());
            assertLe(p.decisionId, gov.currentDecision().id);
        } else {
            assertEq(handler.bridged(), 0);
        }
    }

    /// No value ever reaches the keeper, the guardian or an attacker.
    function invariant_rolesHoldNothing() public view {
        assertEq(keeper.balance, 0);
        assertEq(guardian.balance, 0);
        assertEq(attacker.balance, 0);
        assertEq(usdg.balanceOf(keeper), 0);
        assertEq(usdg.balanceOf(guardian), 0);
        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(usdg.balanceOf(hlAccount), 0);
        assertEq(weth.balanceOf(keeper), 0);
        assertEq(weth.balanceOf(guardian), 0);
        assertEq(weth.balanceOf(attacker), 0);
    }

    /// Roles and immutables are never changed by the handler; nobody else can.
    function invariant_rolesStable() public view {
        assertEq(vault.keeper(), keeper);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.bridgeRecipient(), hlAccount);
        assertEq(vault.capBps(), CAP_BPS);
    }
}

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
///         conversions / orders / reports / close reports / reconciliations with random parameters, simulated
///         bridge returns, guardian revocations and pauses, distributor pulls, and non-keeper attempts.
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
    address distributor;
    int24 baseTick;

    uint256 public ethFunded;
    uint256 public ethSpent;
    uint256 public usdgOut;
    uint256 public floorSum;
    uint256 public conversions;
    uint256 public bridged;
    uint256 public openCapital;
    uint256 public returnedMinted;
    uint256 public executions;
    uint256 public closes;
    int256 public pnlGhost;
    uint256 public distributed;
    bool public capViolated;
    bool public recipientViolated;
    bool public doubleExecution;
    bool public hwmDecreased;
    bool public guardianMovedFunds;
    mapping(uint256 decisionId => uint256 count) public executionsOf;

    constructor(
        WarchestVault vault_,
        MockUniswapV3Pool pool_,
        MockWETH weth_,
        MockUSDG usdg_,
        MockAcrossSpokePool spoke_,
        MockDecisionSource gov_,
        address[5] memory roles, // keeper, guardian, attacker, hlAccount, distributor
        int24 baseTick_
    ) {
        vault = vault_;
        pool = pool_;
        weth = weth_;
        usdg = usdg_;
        spoke = spoke_;
        gov = gov_;
        keeper = roles[0];
        guardian = roles[1];
        attacker = roles[2];
        hlAccount = roles[3];
        distributor = roles[4];
        baseTick = baseTick_;
    }

    modifier hwmMonotonic() {
        uint256 before = vault.highWaterMark();
        _;
        if (vault.highWaterMark() < before) hwmDecreased = true;
    }

    modifier guardianAction() {
        uint256 e = address(vault).balance;
        uint256 u = usdg.balanceOf(address(vault));
        uint256 l = vault.usdgLedger();
        _;
        if (address(vault).balance != e || usdg.balanceOf(address(vault)) != u || vault.usdgLedger() != l) {
            guardianMovedFunds = true;
        }
    }

    // --- environment ---------------------------------------------------------------------------------------------

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
        vm.warp(vm.getBlockTimestamp() + bound(by, 0, 8 hours));
    }

    function decide(uint32 asset, uint8 side) external {
        gov.nextDecision(asset % 3, IWarchestDecisionSource.Side(side % 2));
    }

    function requestClose() external {
        uint256 id = gov.currentDecision().id;
        if (id != 0) gov.setCloseRequested(id, true);
    }

    /// Simulates USDC bridged back (relayer fill on Robinhood Chain): 0..150% of the open capital.
    function bridgeReturn(uint256 bps) external {
        WarchestVault.Position memory p = vault.position();
        if (p.decisionId == 0) return;
        uint256 amount = p.capital * bound(bps, 0, 15_000) / 10_000;
        if (amount == 0) return;
        usdg.mint(address(vault), amount);
        returnedMinted += amount;
    }

    // --- guardian --------------------------------------------------------------------------------------------------

    function pause(bool p) external guardianAction {
        vm.prank(guardian);
        vault.setPaused(p);
    }

    function revokeReport() external guardianAction {
        uint256 id = vault.position().decisionId;
        vm.prank(guardian);
        try vault.revokeReport(id) {} catch {}
    }

    function revokeClose() external guardianAction {
        uint256 id = vault.position().decisionId;
        vm.prank(guardian);
        try vault.revokeCloseReport(id) {} catch {}
    }

    // --- keeper --------------------------------------------------------------------------------------------------

    function convert(uint256 amountIn, uint256 minOutBps) external hwmMonotonic {
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

    function execute(uint256 amount, uint256 outBps, uint32 quoteAgo, uint32 fillIn) external hwmMonotonic {
        uint256 navBefore = vault.nav();
        uint256 cap = navBefore * vault.capBps() / 10_000;
        amount = bound(amount, 0, 2 * cap + 1);
        uint256 outputAmount = amount * bound(outBps, 9_900, 10_050) / 10_000;
        uint32 quoteTs = uint32(vm.getBlockTimestamp()) - uint32(bound(quoteAgo, 0, 4_000));
        uint32 fillDeadline = uint32(vm.getBlockTimestamp()) + uint32(bound(fillIn, 0, 30_000));
        uint256 id = gov.currentDecision().id;

        vm.recordLogs();
        vm.prank(keeper);
        try vault.executeDecision(amount, outputAmount, quoteTs, fillDeadline) {
            executions++;
            bridged += amount;
            openCapital = amount;
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

    function report(uint256 equity) external hwmMonotonic {
        uint256 id = vault.position().decisionId;
        equity = bound(equity, 0, 3 * openCapital + 1);
        vm.prank(keeper);
        try vault.reportPosition(id, equity) {} catch {}
    }

    function reportClosed() external hwmMonotonic {
        uint256 id = vault.position().decisionId;
        vm.prank(keeper);
        try vault.reportClosed(id) {} catch {}
    }

    function finalizeClose(uint256 seed) external hwmMonotonic {
        uint256 id = vault.position().decisionId;
        uint256 capital = vault.position().capital;
        uint256 expectedReturned = usdg.balanceOf(address(vault)) - vault.usdgLedger();
        address caller = seed % 2 == 0 ? attacker : keeper;
        vm.prank(caller);
        try vault.finalizeClose(id) {
            closes++;
            pnlGhost += int256(expectedReturned) - int256(capital);
            openCapital = 0;
        } catch {}
    }

    function reconcile() external hwmMonotonic {
        uint256 stray = usdg.balanceOf(address(vault)) - vault.usdgLedger();
        bool countsAsPnl = vault.lastClosedDecisionId() != 0;
        vm.prank(keeper);
        try vault.reconcile() {
            if (countsAsPnl) pnlGhost += int256(stray);
        } catch {}
    }

    // --- distributor -----------------------------------------------------------------------------------------------

    function pull(uint256 amount) external hwmMonotonic {
        amount = bound(amount, 0, vault.distributable() + 1);
        vm.prank(distributor);
        try vault.pullDistributable(amount) {
            distributed += amount;
        } catch {}
    }

    // --- attackers -------------------------------------------------------------------------------------------------

    function attackerCalls(uint256 amountIn) external {
        uint256 id = vault.position().decisionId;
        vm.startPrank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(amountIn, 0);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(
            amountIn, amountIn, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours
        );
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reportPosition(id, amountIn);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reportClosed(id);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.reconcile();
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(amountIn);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.setPaused(true);
        vm.expectRevert(WarchestVault.NotGuardian.selector);
        vault.setKeeper(attacker);
        vm.stopPrank();
    }

    function guardianCalls(uint256 amountIn) external guardianAction {
        vm.startPrank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.convertEthToUsdg(amountIn, 0);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(
            amountIn, amountIn, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 1 hours
        );
        vm.expectRevert(WarchestVault.NotDistributor.selector);
        vault.pullDistributable(amountIn);
        vm.stopPrank();
    }
}

contract VaultInvariantTest is VaultFixture {
    VaultHandler handler;

    function setUp() public {
        _deployVault();
        handler = new VaultHandler(
            vault, pool, weth, usdg, spoke, gov, [keeper, guardian, attacker, hlAccount, distributor], TICK
        );
        targetContract(address(handler));
    }

    /// ETH only ever leaves the vault through a conversion, and exactly the converted amount.
    function invariant_ethConservation() public view {
        assertEq(address(vault).balance, handler.ethFunded() - handler.ethSpent());
        assertEq(weth.balanceOf(address(pool)), handler.ethSpent());
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    /// USDG is in the vault, in the SpokePool (bridged for the immutable recipient) or at the distributor; the
    /// ledger never exceeds the balance and no allowance is left behind.
    function invariant_usdgConservation() public view {
        assertEq(
            usdg.balanceOf(address(vault)) + usdg.balanceOf(address(spoke)) + usdg.balanceOf(distributor),
            handler.usdgOut() + handler.returnedMinted()
        );
        assertEq(usdg.balanceOf(address(spoke)), handler.bridged());
        assertEq(usdg.balanceOf(distributor), handler.distributed());
        assertLe(vault.usdgLedger(), usdg.balanceOf(address(vault)));
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
        assertLe(handler.executions(), handler.closes() + 1);
    }

    /// An open position always matches the last executed decision and its capital; nothing is distributable then.
    function invariant_positionConsistent() public view {
        WarchestVault.Position memory p = vault.position();
        if (p.decisionId != 0) {
            assertEq(p.decisionId, vault.lastExecutedDecisionId());
            assertEq(p.capital, handler.openCapital());
            assertLe(p.decisionId, gov.currentDecision().id);
            assertEq(vault.distributable(), 0);
        } else {
            assertEq(handler.openCapital(), 0);
        }
    }

    /// Realized PnL is exactly Σ (measured returns − capital) + late returns; the high-water mark equals what was
    /// distributed and never decreases; distributable never exceeds the accounted USDG nor PnL above the mark.
    function invariant_pnlAndHighWaterMark() public view {
        assertEq(vault.cumulativePnl(), handler.pnlGhost());
        assertEq(vault.highWaterMark(), handler.distributed());
        assertFalse(handler.hwmDecreased());
        uint256 d = vault.distributable();
        assertLe(d, vault.usdgLedger());
        if (d > 0) assertLe(int256(d + vault.highWaterMark()), vault.cumulativePnl());
    }

    /// The guardian never changes a balance.
    function invariant_guardianNeverMovesFunds() public view {
        assertFalse(handler.guardianMovedFunds());
        assertEq(usdg.balanceOf(guardian), 0);
        assertEq(guardian.balance, 0);
    }

    /// No value ever reaches the keeper or an attacker; the Hyperliquid account only receives on the other chain.
    function invariant_rolesHoldNothing() public view {
        assertEq(keeper.balance, 0);
        assertEq(attacker.balance, 0);
        assertEq(usdg.balanceOf(keeper), 0);
        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(usdg.balanceOf(hlAccount), 0);
        assertEq(weth.balanceOf(keeper), 0);
        assertEq(weth.balanceOf(attacker), 0);
    }

    /// Roles and immutables are never changed by the handler; nobody else can.
    function invariant_rolesStable() public view {
        assertEq(vault.keeper(), keeper);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.bridgeRecipient(), hlAccount);
        assertEq(vault.distributor(), distributor);
        assertEq(vault.capBps(), CAP_BPS);
    }
}

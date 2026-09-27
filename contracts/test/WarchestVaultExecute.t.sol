// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Test.sol";
import {WarchestVault} from "../src/WarchestVault.sol";
import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {IAcrossSpokePool} from "../src/interfaces/external/IAcrossSpokePool.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";

/// @notice S3.2: order execution against a mocked governance and a mocked Across SpokePool.
contract WarchestVaultExecuteTest is VaultFixture {
    event OrderExecuted(
        uint256 indexed decisionId,
        uint32 indexed asset,
        IWarchestDecisionSource.Side side,
        uint256 capital,
        uint256 outputAmount,
        uint256 depositId,
        uint16 stopLossBps,
        uint8 leverage,
        uint16 takeProfitBps
    );

    uint256 ledger0;

    function setUp() public {
        _deployVault();
        _fund(attacker, 100 ether);
        _convert(MAX_CONVERT, vault.twapFloor(MAX_CONVERT));
        ledger0 = vault.usdgLedger(); // ≈ 135 000 USDG, plus 50 ETH still unconverted
    }

    function _bytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _recipientOf(bytes memory data) internal pure returns (bytes32 recipient) {
        assembly ("memory-safe") {
            recipient := mload(add(data, 0x100)) // 0x20 length prefix + 7 words
        }
    }

    function _now() internal view returns (uint32) {
        return uint32(vm.getBlockTimestamp());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    function test_constructor_bridgeAndOrderImmutables() public view {
        assertEq(address(vault.governance()), address(gov));
        assertEq(address(vault.spokePool()), address(spoke));
        assertEq(vault.bridgeRecipient(), hlAccount);
        assertEq(vault.bridgeOutputToken(), usdcHyperEvm);
        assertEq(vault.destinationChainId(), DEST_CHAIN);
        assertEq(vault.capBps(), CAP_BPS);
        assertEq(vault.MAX_CAP_BPS(), 2_000);
        assertEq(vault.maxBridgeFeeBps(), MAX_BRIDGE_FEE_BPS);
        assertEq(vault.maxDecisionAge(), MAX_DECISION_AGE);
        (uint16 sl, uint8 lev, uint16 tp) = vault.riskParams();
        assertEq(sl, STOP_LOSS_BPS);
        assertEq(lev, LEVERAGE);
        assertEq(tp, TAKE_PROFIT_BPS);
        assertEq(vault.lastExecutedDecisionId(), 0);
        assertEq(vault.position().decisionId, 0);
        assertFalse(vault.mustClose());
    }

    function test_constructor_revertsInvalidBridge() public {
        WarchestVault.Bridge memory b = _bridge();
        b.spokePool = IAcrossSpokePool(address(0));
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        new WarchestVault(guardian, keeper, gov, distributor, _venue(), b, _conversionParams(), _orderParams());
        b = _bridge();
        b.recipient = address(0);
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        new WarchestVault(guardian, keeper, gov, distributor, _venue(), b, _conversionParams(), _orderParams());
        b = _bridge();
        b.outputToken = address(0);
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        new WarchestVault(guardian, keeper, gov, distributor, _venue(), b, _conversionParams(), _orderParams());
        b = _bridge();
        b.destinationChainId = 0;
        vm.expectRevert(WarchestVault.InvalidParams.selector);
        new WarchestVault(guardian, keeper, gov, distributor, _venue(), b, _conversionParams(), _orderParams());
        vm.expectRevert(WarchestVault.ZeroAddress.selector);
        new WarchestVault(
            guardian,
            keeper,
            IWarchestDecisionSource(address(0)),
            distributor,
            _venue(),
            _bridge(),
            _conversionParams(),
            _orderParams()
        );
    }

    function test_constructor_revertsInvalidOrderParams() public {
        WarchestVault.OrderParams memory p = _orderParams();
        p.capBps = 0;
        _expectInvalidOrderParams(p);
        p = _orderParams();
        p.capBps = 2_001; // the 20% hard cap is enforced at deployment
        _expectInvalidOrderParams(p);
        p = _orderParams();
        p.maxBridgeFeeBps = 501;
        _expectInvalidOrderParams(p);
        p = _orderParams();
        p.maxDecisionAge = 0;
        _expectInvalidOrderParams(p);
        p = _orderParams();
        p.stopLossBps = 0;
        _expectInvalidOrderParams(p);
        p = _orderParams();
        p.stopLossBps = 10_000;
        _expectInvalidOrderParams(p);
        p = _orderParams();
        p.leverage = 0;
        _expectInvalidOrderParams(p);
        p = _orderParams();
        p.takeProfitBps = 0;
        _expectInvalidOrderParams(p);
        // a zero bridge fee bound (must receive 100%) is allowed
        p = _orderParams();
        p.maxBridgeFeeBps = 0;
        new WarchestVault(guardian, keeper, gov, distributor, _venue(), _bridge(), _conversionParams(), p);
    }

    function _expectInvalidOrderParams(WarchestVault.OrderParams memory p) internal {
        vm.expectRevert(WarchestVault.InvalidParams.selector);
        new WarchestVault(guardian, keeper, gov, distributor, _venue(), _bridge(), _conversionParams(), p);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Happy path
    // ---------------------------------------------------------------------------------------------------------------

    function test_execute_happyPath() public {
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 amount = vault.maxOrderAmount();
        uint256 navBefore = vault.nav();
        assertEq(amount, navBefore * CAP_BPS / BPS);
        assertLt(amount, ledger0);
        uint256 out = amount * (BPS - MAX_BRIDGE_FEE_BPS) / BPS;

        vm.expectEmit(true, true, false, true, address(vault));
        emit OrderExecuted(
            id, BTC, IWarchestDecisionSource.Side.Long, amount, out, 0, STOP_LOSS_BPS, LEVERAGE, TAKE_PROFIT_BPS
        );
        _execute(amount);

        WarchestVault.Position memory p = vault.position();
        assertEq(p.decisionId, id);
        assertEq(p.asset, BTC);
        assertEq(uint8(p.side), uint8(IWarchestDecisionSource.Side.Long));
        assertEq(p.capital, amount);
        assertEq(p.openedAt, vm.getBlockTimestamp());
        assertEq(p.depositId, 0);
        assertEq(vault.lastExecutedDecisionId(), id);
        assertEq(vault.usdgLedger(), ledger0 - amount);
        assertEq(usdg.balanceOf(address(vault)), ledger0 - amount);
        assertEq(usdg.balanceOf(address(spoke)), amount);
        assertEq(usdg.allowance(address(vault), address(spoke)), 0);
        assertEq(spoke.numberOfDeposits(), 1);
        assertFalse(vault.mustClose());
        // NAV dropped by exactly the capital: deployed capital is not counted
        assertEq(vault.nav(), navBefore - amount);
    }

    /// The Across deposit carries the immutable recipient / output token / chain and nothing the keeper chose
    /// besides the four bounded parameters.
    function test_execute_depositFieldsAreImmutable() public {
        gov.nextDecision(ETH_ASSET, IWarchestDecisionSource.Side.Short);
        uint256 amount = 1_000e6;
        uint256 out = 999e6;
        vm.expectEmit(true, true, true, true, address(spoke));
        emit IAcrossSpokePool.FundsDeposited(
            _bytes32(address(usdg)),
            _bytes32(usdcHyperEvm),
            amount,
            out,
            DEST_CHAIN,
            0,
            _now(),
            _now() + FILL_WINDOW,
            0,
            _bytes32(address(vault)),
            _bytes32(hlAccount),
            bytes32(0),
            ""
        );
        vm.prank(keeper);
        vault.executeDecision(amount, out, _now(), _now() + FILL_WINDOW);
        WarchestVault.Position memory p = vault.position();
        assertEq(p.asset, ETH_ASSET);
        assertEq(uint8(p.side), uint8(IWarchestDecisionSource.Side.Short));
    }

    function test_execute_recordsSpokeDepositId() public {
        // someone else deposits first: our deposit id must be the SpokePool's counter, not a local one
        usdg.mint(attacker, 5e6);
        vm.startPrank(attacker);
        usdg.approve(address(spoke), 5e6);
        spoke.deposit(
            _bytes32(attacker),
            _bytes32(attacker),
            _bytes32(address(usdg)),
            _bytes32(usdcHyperEvm),
            5e6,
            5e6,
            DEST_CHAIN,
            bytes32(0),
            _now(),
            _now() + 1 hours,
            0,
            ""
        );
        vm.stopPrank();
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        assertEq(vault.position().depositId, 1);
    }

    function test_execute_smallAmountBelowCap() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1);
        assertEq(vault.position().capital, 1);
    }

    function test_execute_zeroBridgeFeeAccepted() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vault.executeDecision(1_000e6, 1_000e6, _now(), _now() + FILL_WINDOW);
        assertEq(vault.position().capital, 1_000e6);
    }

    function test_execute_quoteTimestampOneHourOldAccepted() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vault.executeDecision(1_000e6, 999e6, _now() - 3600, _now() + FILL_WINDOW);
        assertEq(vault.position().capital, 1_000e6);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Reverts (vault-level)
    // ---------------------------------------------------------------------------------------------------------------

    function _assertNothingHappened() internal view {
        assertEq(vault.position().decisionId, 0);
        assertEq(vault.lastExecutedDecisionId(), 0);
        assertEq(vault.usdgLedger(), ledger0);
        assertEq(usdg.balanceOf(address(vault)), ledger0);
        assertEq(usdg.balanceOf(address(spoke)), 0);
        assertEq(usdg.allowance(address(vault), address(spoke)), 0);
        assertEq(spoke.numberOfDeposits(), 0);
    }

    function test_execute_revertsNotKeeper() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        vm.prank(attacker);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    function test_execute_revertsWhenPaused() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(guardian);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.IsPaused.selector);
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    function test_execute_revertsNoDecision() public {
        vm.prank(keeper);
        vm.expectRevert(WarchestVault.NoDecision.selector);
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    function test_execute_revertsSameDecisionTwice() public {
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionAlreadyExecuted.selector, id, id));
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        assertEq(usdg.balanceOf(address(spoke)), 1_000e6);
    }

    function test_execute_revertsWhilePositionOpen() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        uint256 id2 = gov.nextDecision(ETH_ASSET, IWarchestDecisionSource.Side.Short);
        assertTrue(vault.mustClose(), "superseded position must close first");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionOpen.selector, id2 - 1));
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        assertEq(vault.lastExecutedDecisionId(), id2 - 1);
        assertEq(usdg.balanceOf(address(spoke)), 1_000e6);
    }

    function test_execute_revertsStaleDecision() public {
        uint64 endsAt = uint64(vm.getBlockTimestamp());
        gov.setDecision(1, BTC, IWarchestDecisionSource.Side.Long, 7, endsAt);
        vm.warp(endsAt + MAX_DECISION_AGE + 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionStale.selector, 1, endsAt));
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();

        // exactly at the limit is fine
        vm.warp(endsAt + MAX_DECISION_AGE);
        _execute(1_000e6);
        assertEq(vault.position().decisionId, 1);
    }

    function test_execute_revertsUnknownRound() public {
        gov.setDecision(1, BTC, IWarchestDecisionSource.Side.Long, 7, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionStale.selector, 1, 0));
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
    }

    function test_execute_revertsCapExceeded() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 max = vault.maxOrderAmount();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.CapExceeded.selector, max + 1, max));
        vault.executeDecision(max + 1, max, _now(), _now() + FILL_WINDOW);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.CapExceeded.selector, 0, max));
        vault.executeDecision(0, 0, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    /// The cap is 20% of USDG + ETH-at-floor; both parts count, deployed capital never does.
    function test_execute_capUsesNavWithEthAtFloor() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 expectedNav = usdg.balanceOf(address(vault)) + vault.twapFloor(address(vault).balance);
        assertEq(vault.nav(), expectedNav);
        assertEq(vault.maxOrderAmount(), expectedNav * 2_000 / 10_000);
        _execute(vault.maxOrderAmount());
        // ETH price crash after execution does not matter for the already-open position, but a new cap would
        pool.setTwapTick(TICK - 5_000);
        assertLt(vault.nav(), expectedNav - vault.position().capital);
    }

    /// Unaccounted USDG (donation, early bridge refund) raises the NAV but cannot be bridged before it is reconciled.
    function test_execute_revertsLedgerInsufficient() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        usdg.mint(address(vault), 10 * ledger0);
        uint256 max = vault.maxOrderAmount();
        assertGt(max, ledger0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.LedgerInsufficient.selector, max, ledger0));
        vault.executeDecision(max, max, _now(), _now() + FILL_WINDOW);
        _execute(ledger0);
        assertEq(vault.usdgLedger(), 0);
    }

    function test_execute_revertsBridgeFeeTooHigh() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 amount = 1_000e6;
        uint256 minOut = amount * (BPS - MAX_BRIDGE_FEE_BPS) / BPS;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.BridgeFeeTooHigh.selector, minOut - 1, minOut));
        vault.executeDecision(amount, minOut - 1, _now(), _now() + FILL_WINDOW);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.BridgeFeeTooHigh.selector, 0, minOut));
        vault.executeDecision(amount, 0, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    function test_execute_revertsOutputAboveInput() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.InvalidOutputAmount.selector, 1_000e6 + 1, 1_000e6));
        vault.executeDecision(1_000e6, 1_000e6 + 1, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    function test_execute_revertsPastFillDeadline() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.InvalidFillDeadline.selector, _now()));
        vault.executeDecision(1_000e6, 999e6, _now(), _now());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.InvalidFillDeadline.selector, 0));
        vault.executeDecision(1_000e6, 999e6, _now(), 0);
        _assertNothingHappened();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Reverts (SpokePool-level, propagated)
    // ---------------------------------------------------------------------------------------------------------------

    function test_execute_spokeRejectsFutureOrOldQuoteTimestamp() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vm.expectRevert(MockAcrossSpokePool.InvalidQuoteTimestamp.selector);
        vault.executeDecision(1_000e6, 999e6, _now() + 1, _now() + FILL_WINDOW);
        vm.prank(keeper);
        vm.expectRevert(MockAcrossSpokePool.InvalidQuoteTimestamp.selector);
        vault.executeDecision(1_000e6, 999e6, _now() - 3601, _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    function test_execute_spokeRejectsFillDeadlineBeyondBuffer() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vm.expectRevert(MockAcrossSpokePool.InvalidFillDeadline.selector);
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + 21_601);
        _assertNothingHappened();
    }

    function test_execute_spokePausedPropagates() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        spoke.setPausedDeposits(true);
        vm.prank(keeper);
        vm.expectRevert(MockAcrossSpokePool.DepositsArePaused.selector);
        vault.executeDecision(1_000e6, 999e6, _now(), _now() + FILL_WINDOW);
        _assertNothingHappened();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // mustClose
    // ---------------------------------------------------------------------------------------------------------------

    function test_mustClose_whenFlatIsFalse() public {
        assertFalse(vault.mustClose());
        vm.prank(guardian);
        vault.setPaused(true);
        assertFalse(vault.mustClose());
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        gov.setCloseRequested(1, true);
        assertFalse(vault.mustClose());
    }

    function test_mustClose_onCloseRequest() public {
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        assertFalse(vault.mustClose());
        gov.setCloseRequested(id, true);
        assertTrue(vault.mustClose());
    }

    function test_mustClose_onSupersededEvenSameAssetAndSide() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        assertTrue(vault.mustClose());
    }

    function test_mustClose_onPause() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        _execute(1_000e6);
        vm.prank(guardian);
        vault.setPaused(true);
        assertTrue(vault.mustClose());
        vm.prank(guardian);
        vault.setPaused(false);
        assertFalse(vault.mustClose());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Fuzz / malicious keeper
    // ---------------------------------------------------------------------------------------------------------------

    /// For any (amount, outputAmount), the order either reverts or bridges ≤ 20% of the NAV with a bounded fee, to
    /// the immutable recipient, and USDG only ever moves from the vault to the SpokePool.
    function testFuzz_execute_boundsHold(uint256 amount, uint256 outputAmount, uint96 extraEth) public {
        _fund(attacker, extraEth);
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 navBefore = vault.nav();
        uint256 max = vault.maxOrderAmount();
        amount = bound(amount, 0, 2 * ledger0);
        outputAmount = bound(outputAmount, 0, amount + 1);
        uint256 minOut = amount * (BPS - MAX_BRIDGE_FEE_BPS) / BPS;
        bool shouldPass =
            amount > 0 && amount <= max && amount <= ledger0 && outputAmount >= minOut && outputAmount <= amount;

        vm.recordLogs();
        vm.prank(keeper);
        if (!shouldPass) vm.expectRevert();
        vault.executeDecision(amount, outputAmount, _now(), _now() + FILL_WINDOW);

        if (shouldPass) {
            WarchestVault.Position memory p = vault.position();
            assertEq(p.capital, amount);
            assertLe(p.capital * BPS, navBefore * CAP_BPS);
            assertEq(usdg.balanceOf(address(spoke)), amount);
            assertEq(usdg.balanceOf(address(vault)) + usdg.balanceOf(address(spoke)), ledger0);
            // recipient in the SpokePool event is the immutable one (word 7 of the non-indexed data)
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bool found;
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == address(spoke) && logs[i].topics[0] == IAcrossSpokePool.FundsDeposited.selector)
                {
                    found = true;
                    assertEq(_recipientOf(logs[i].data), _bytes32(hlAccount), "recipient");
                    assertEq(logs[i].topics[3], _bytes32(address(vault)), "depositor");
                }
            }
            assertTrue(found);
        } else {
            _assertNothingHappened();
        }
    }

    /// A stolen keeper key: repeated attempts across many decisions never move more than the cap per decision and
    /// never a second time for the same decision.
    function test_maliciousKeeper_atMostCapOncePerDecision() public {
        uint256 id = gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        uint256 max = vault.maxOrderAmount();
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.CapExceeded.selector, max * 2, max));
        vault.executeDecision(max * 2, max * 2, _now(), _now() + FILL_WINDOW);
        vault.executeDecision(max, max, _now(), _now() + FILL_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionAlreadyExecuted.selector, id, id));
        vault.executeDecision(1, 1, _now(), _now() + FILL_WINDOW);
        vm.stopPrank();
        // governance issues a new decision: still blocked while the first position is open
        uint256 id2 = gov.nextDecision(ETH_ASSET, IWarchestDecisionSource.Side.Long);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionOpen.selector, id));
        vault.executeDecision(1, 1, _now(), _now() + FILL_WINDOW);
        assertEq(usdg.balanceOf(address(spoke)), max);
        assertEq(id2, id + 1);
    }

    /// The guardian has no way to move funds either: it is not the keeper, and there is no recipient setter.
    function test_guardianCannotExecute() public {
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        vm.prank(guardian);
        vm.expectRevert(WarchestVault.NotKeeper.selector);
        vault.executeDecision(1, 1, _now(), _now() + FILL_WINDOW);
    }
}

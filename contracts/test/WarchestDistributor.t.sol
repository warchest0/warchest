// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WarchestDistributor, IWarchestVaultDistribution} from "../src/WarchestDistributor.sol";
import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";

/// @notice WarchestDistributor wired to the REAL WarchestVault (mocked venue/bridge/governance, VaultFixture).
contract WarchestDistributorTest is VaultFixture {
    uint64 constant TIMELOCK = 1 days;
    address updater = makeAddr("distUpdater");
    WarchestDistributor dist;

    uint256 decisionId;
    uint256 capital;
    address[] holders;
    uint256[] cumulative;

    function setUp() public {
        _deployVenue();
        dist = new WarchestDistributor(usdg, guardian, updater, TIMELOCK);
        distributor = address(dist); // the vault takes the distributor address as an immutable
        vault = _newVault(guardian, keeper, _venue(), _conversionParams());
        vm.prank(guardian);
        dist.setVault(IWarchestVaultDistribution(address(vault)));
        (decisionId, capital) = _openPosition();
    }

    function _closeWithProfit(uint256 profit) internal {
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW); // minimum position age before a keeper-initiated close
        vm.prank(keeper);
        vault.reportClosed(decisionId);
        usdg.mint(address(vault), capital + profit); // bridged back
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(decisionId);
    }

    function _tree(uint256[] memory amounts) internal returns (bytes32 root, uint256 total) {
        delete holders;
        delete cumulative;
        bytes32[] memory leaves = new bytes32[](amounts.length);
        for (uint256 i; i < amounts.length; ++i) {
            holders.push(makeAddr(string.concat("holder", vm.toString(i))));
            cumulative.push(amounts[i]);
            leaves[i] = dist.leaf(holders[i], amounts[i]);
            total += amounts[i];
        }
        root = MerkleHelper.root(leaves);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) {
        bytes32[] memory leaves = new bytes32[](holders.length);
        for (uint256 j; j < holders.length; ++j) {
            leaves[j] = dist.leaf(holders[j], cumulative[j]);
        }
        return MerkleHelper.proof(leaves, i);
    }

    function _publish(uint256[] memory amounts) internal returns (uint256 total) {
        bytes32 root;
        (root, total) = _tree(amounts);
        vm.prank(updater);
        dist.proposeRoot(root, total, keccak256("tree"));
        vm.warp(vm.getBlockTimestamp() + TIMELOCK);
        dist.acceptRoot();
    }

    function _amounts(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory x) {
        x = new uint256[](3);
        (x[0], x[1], x[2]) = (a, b, c);
    }

    // ------------------------------------------------------------------ funding

    function test_fund_pullsOnlyProfitAboveHighWaterMark() public {
        vm.expectRevert(WarchestDistributor.NothingToFund.selector); // position open → 0
        dist.fund();
        _closeWithProfit(10_000e6);
        assertEq(dist.fund(), 10_000e6);
        assertEq(dist.totalFunded(), 10_000e6);
        assertEq(usdg.balanceOf(address(dist)), 10_000e6);
        assertEq(vault.highWaterMark(), 10_000e6);
        vm.expectRevert(WarchestDistributor.NothingToFund.selector);
        dist.fund();
    }

    function test_fund_lossDistributesNothing() public {
        vm.prank(keeper);
        vault.reportClosed(decisionId);
        usdg.mint(address(vault), capital / 2);
        vm.warp(vm.getBlockTimestamp() + REPORT_WINDOW);
        vault.finalizeClose(decisionId);
        vm.expectRevert(WarchestDistributor.NothingToFund.selector);
        dist.fund();
    }

    function test_fund_requiresVault() public {
        WarchestDistributor d2 = new WarchestDistributor(usdg, guardian, updater, TIMELOCK);
        vm.expectRevert(WarchestDistributor.VaultNotSet.selector);
        d2.fund();
    }

    function test_setVault_onceOnlyGuardian() public {
        vm.expectRevert(WarchestDistributor.NotGuardian.selector);
        dist.setVault(IWarchestVaultDistribution(address(1)));
        vm.prank(guardian);
        vm.expectRevert(WarchestDistributor.VaultAlreadySet.selector);
        dist.setVault(IWarchestVaultDistribution(address(1)));
    }

    // ------------------------------------------------------------------ roots

    function test_root_timelockAndGuardianRevoke() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        (bytes32 root, uint256 total) = _tree(_amounts(5_000e6, 3_000e6, 2_000e6));
        vm.prank(updater);
        dist.proposeRoot(root, total, 0);

        vm.expectRevert(
            abi.encodeWithSelector(WarchestDistributor.TimelockNotElapsed.selector, vm.getBlockTimestamp() + TIMELOCK)
        );
        dist.acceptRoot();

        // a compromised updater cannot reset the timelock by re-proposing
        vm.prank(updater);
        vm.expectRevert(WarchestDistributor.PendingRootExists.selector);
        dist.proposeRoot(root, total, 0);

        vm.prank(guardian);
        dist.revokePendingRoot();
        vm.expectRevert(WarchestDistributor.NoPendingRoot.selector);
        dist.acceptRoot();
        assertEq(dist.root(), bytes32(0));
    }

    function test_root_boundedByFunding() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        vm.startPrank(updater);
        vm.expectRevert(abi.encodeWithSelector(WarchestDistributor.ExceedsFunded.selector, 10_001e6, 10_000e6));
        dist.proposeRoot(bytes32(uint256(1)), 10_001e6, 0);
        vm.expectRevert(WarchestDistributor.EmptyRoot.selector);
        dist.proposeRoot(bytes32(0), 1, 0);
        vm.stopPrank();
        vm.expectRevert(WarchestDistributor.NotUpdater.selector);
        dist.proposeRoot(bytes32(uint256(1)), 1, 0);
    }

    function test_root_cumulativeNeverDecreases() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        _publish(_amounts(5_000e6, 3_000e6, 2_000e6));
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(WarchestDistributor.CumulativeDecreased.selector, 1, 10_000e6));
        dist.proposeRoot(bytes32(uint256(1)), 1, 0);
    }

    // ------------------------------------------------------------------ claims

    function test_claim_paysEachHolderOnce() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        _publish(_amounts(5_000e6, 3_000e6, 2_000e6));
        for (uint256 i; i < 3; ++i) {
            bytes32[] memory p = _proof(i);
            vm.prank(attacker); // anyone can trigger; funds go to the holder
            dist.claim(holders[i], cumulative[i], p);
            assertEq(usdg.balanceOf(holders[i]), cumulative[i]);
        }
        assertEq(dist.totalClaimed(), 10_000e6);
        assertEq(usdg.balanceOf(address(dist)), 0);
        bytes32[] memory p0 = _proof(0);
        vm.expectRevert(WarchestDistributor.NothingToClaim.selector);
        dist.claim(holders[0], cumulative[0], p0);
    }

    function test_claim_cumulativeAcrossDistributions() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        _publish(_amounts(5_000e6, 3_000e6, 2_000e6));
        bytes32[] memory p = _proof(0);
        dist.claim(holders[0], 5_000e6, p);

        // second profitable cycle
        gov.nextDecision(BTC, IWarchestDecisionSource.Side.Long);
        capital = vault.maxOrderAmount();
        _execute(capital);
        decisionId = vault.position().decisionId;
        _closeWithProfit(6_000e6);
        dist.fund();
        _publish(_amounts(8_000e6, 5_000e6, 3_000e6)); // +3000, +2000, +1000
        p = _proof(0);
        assertEq(dist.claim(holders[0], 8_000e6, p), 3_000e6);
        p = _proof(1);
        assertEq(dist.claim(holders[1], 5_000e6, p), 5_000e6);
        assertEq(usdg.balanceOf(holders[0]), 8_000e6);
    }

    function test_claim_rejectsForgedAmountAndOtherAccount() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        _publish(_amounts(5_000e6, 3_000e6, 2_000e6));
        bytes32[] memory p = _proof(2);
        vm.expectRevert(WarchestDistributor.InvalidProof.selector);
        dist.claim(holders[2], 9_000e6, p);
        vm.expectRevert(WarchestDistributor.InvalidProof.selector);
        dist.claim(attacker, 2_000e6, p);
    }

    /// An updater that under-declares `totalCumulative` can only stall late claimers, never overdraw funds.
    function test_claim_underDeclaredTreeCannotOverdraw() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        (bytes32 root,) = _tree(_amounts(5_000e6, 3_000e6, 2_000e6));
        vm.prank(updater);
        dist.proposeRoot(root, 6_000e6, 0); // lies: leaves sum to 10k
        vm.warp(vm.getBlockTimestamp() + TIMELOCK);
        dist.acceptRoot();
        bytes32[] memory p = _proof(0);
        dist.claim(holders[0], 5_000e6, p);
        p = _proof(1);
        vm.expectRevert(WarchestDistributor.ExceedsRootTotal.selector);
        dist.claim(holders[1], 3_000e6, p);
        assertLe(dist.totalClaimed(), dist.totalCumulative());
    }

    function test_guardianCannotMoveFunds() public {
        _closeWithProfit(10_000e6);
        dist.fund();
        // the guardian's whole surface: none of these transfer tokens, and none lets it publish a root
        vm.startPrank(guardian);
        dist.proposeUpdater(guardian);
        dist.cancelUpdaterChange();
        dist.proposeUpdater(guardian);
        dist.transferGuardian(guardian);
        vm.expectRevert(WarchestDistributor.NotUpdater.selector);
        dist.proposeRoot(bytes32(uint256(1)), 1, 0);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(dist)), 10_000e6);
        assertEq(dist.updater(), updater);
    }

    // ------------------------------------------------------------------ updater rotation (review HIGH)

    function test_updaterRotation_delayedPublicPermissionless() public {
        address next = makeAddr("nextUpdater");
        uint64 readyAt = uint64(vm.getBlockTimestamp()) + dist.updaterDelay();
        assertEq(dist.updaterDelay(), TIMELOCK + 3 days);

        vm.expectRevert(WarchestDistributor.NotGuardian.selector);
        dist.proposeUpdater(next);
        vm.prank(guardian);
        vm.expectRevert(WarchestDistributor.ZeroAddress.selector);
        dist.proposeUpdater(address(0));
        vm.expectRevert(WarchestDistributor.NoPendingUpdater.selector);
        dist.applyUpdaterChange();
        vm.prank(guardian);
        vm.expectRevert(WarchestDistributor.NoPendingUpdater.selector);
        dist.cancelUpdaterChange();

        vm.expectEmit(true, false, false, true, address(dist));
        emit WarchestDistributor.UpdaterChangeProposed(next, readyAt);
        vm.prank(guardian);
        dist.proposeUpdater(next);
        assertEq(dist.pendingUpdater(), next);
        assertEq(dist.pendingUpdaterReadyAt(), readyAt);

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(WarchestDistributor.UpdaterDelayNotElapsed.selector, readyAt));
        dist.applyUpdaterChange();
        assertEq(dist.updater(), updater, "old updater keeps the role during the notice");

        vm.warp(readyAt);
        vm.expectEmit(true, true, false, true, address(dist));
        emit WarchestDistributor.UpdaterChanged(updater, next);
        vm.prank(attacker); // permissionless
        dist.applyUpdaterChange();
        assertEq(dist.updater(), next);
        assertEq(dist.pendingUpdater(), address(0));
        assertEq(dist.pendingUpdaterReadyAt(), 0);
    }

    function test_updaterRotation_cancelAndReproposeRestartsDelay() public {
        address next = makeAddr("nextUpdater");
        vm.prank(guardian);
        dist.proposeUpdater(next);
        vm.warp(vm.getBlockTimestamp() + dist.updaterDelay() - 1);
        vm.expectEmit(true, false, false, true, address(dist));
        emit WarchestDistributor.UpdaterChangeCancelled(next);
        vm.prank(guardian);
        dist.cancelUpdaterChange();
        vm.expectRevert(WarchestDistributor.NoPendingUpdater.selector);
        dist.applyUpdaterChange();

        uint64 readyAt = uint64(vm.getBlockTimestamp()) + dist.updaterDelay();
        vm.prank(guardian);
        dist.proposeUpdater(next);
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(WarchestDistributor.UpdaterDelayNotElapsed.selector, readyAt));
        dist.applyUpdaterChange();
    }

    function test_leafDomainSeparated() public {
        WarchestDistributor d2 = new WarchestDistributor(usdg, guardian, updater, TIMELOCK);
        assertTrue(d2.leaf(attacker, 1) != dist.leaf(attacker, 1));
    }
}

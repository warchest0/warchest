// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IWarchestDecisionSource} from "../../src/interfaces/IWarchestDecisionSource.sol";
import {DeployTestnet} from "../../script/DeployTestnet.s.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";

/// @notice Runs `DeployTestnet` on a Robinhood TESTNET fork (official v4, testnet stand-ins for WETH/USDG/oracle/
///         Across) and drives the full cycle: trade → fee → convert → snapshot → vote → order (mock Across deposit)
///         → close → funds back → PnL → distributor claim. Skipped when ROBINHOOD_TESTNET_RPC_URL is unset.
contract DeployTestnetForkTest is Test, DeployTestnet {
    address deployer = makeAddr("deployer");
    address[] holders;
    uint256[] weights;
    Venue v;
    System s;

    function _leaves(uint64 epoch) internal view returns (bytes32[] memory l) {
        l = new bytes32[](holders.length);
        for (uint256 i; i < holders.length; ++i) {
            l[i] = s.governance.leaf(epoch, holders[i], weights[i]);
        }
    }

    function test_testnetDeployAndFullCycle() public {
        string memory url = vm.envOr("ROBINHOOD_TESTNET_RPC_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        assertEq(block.chainid, TESTNET_CHAIN_ID);

        vm.deal(deployer, 10 ether);
        vm.startBroadcast(deployer);
        (v, s) = deployTestnet(deployer);
        vm.stopBroadcast();
        assertEq(s.vault.guardian(), deployer);
        assertEq(s.launch.hook.vault(), address(s.vault));

        // trade → 10% fee → vault
        PoolSwapTest router = new PoolSwapTest(IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951));
        vm.deal(address(this), 1 ether);
        router.swap{value: 0.01 ether}(
            s.launch.key,
            SwapParams(true, -0.01 ether, TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        s.launch.hook.flush();
        uint256 fees = address(s.vault).balance;
        assertEq(fees, 0.001 ether - 1);

        // convert at the oracle price (≈ $2,690) — the keeper defaults to the deployer
        uint256 floor = s.vault.twapFloor(fees); // computed before the prank (an external call would consume it)
        vm.prank(deployer);
        uint256 usdgOut = s.vault.convertEthToUsdg(fees, floor);
        assertApproxEqRel(usdgOut, fees * 2690 / 1e12, 0.01e18);

        // snapshot → vote → decision
        holders.push(makeAddr("h0"));
        holders.push(makeAddr("h1"));
        weights.push(700);
        weights.push(300);
        uint64 epoch = uint64(vm.getBlockTimestamp() / 1 days);
        bytes32 root = MerkleHelper.root(_leaves(epoch));
        vm.prank(deployer);
        s.governance.submitWeightRoot(epoch, root, 1000, 0);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 roundId = s.governance.startDirectionRound(epoch);
        bytes32[] memory p = MerkleHelper.proof(_leaves(epoch), 0);
        vm.prank(holders[0]);
        s.governance.vote(roundId, 3, 700, p); // ETH short
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        s.governance.finalize(roundId);
        assertEq(s.governance.currentDecision().id, 1);
        assertEq(uint8(s.governance.currentDecision().side), uint8(IWarchestDecisionSource.Side.Short));

        // order ≤ 20% of NAV into the mock SpokePool
        uint256 amount = s.vault.maxOrderAmount();
        uint256 minOut = amount * 9_960 / 10_000;
        uint32 ts = uint32(vm.getBlockTimestamp());
        vm.prank(deployer);
        s.vault.executeDecision(amount, minOut, ts, ts + 4 hours);
        assertEq(v.usdg.balanceOf(address(v.spokePool)), amount);

        // close after the minimum position age, +10% comes back, PnL booked, profit distributed
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(deployer);
        s.vault.reportClosed(1);
        vm.prank(deployer);
        v.usdg.mint(address(s.vault), amount * 110 / 100);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        s.vault.finalizeClose(1);
        assertEq(s.vault.cumulativePnl(), int256(amount / 10));
        assertEq(s.distributor.fund(), amount / 10);
    }
}

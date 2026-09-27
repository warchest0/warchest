// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WarchestVault} from "../src/WarchestVault.sol";
import {WarchestGovernance} from "../src/WarchestGovernance.sol";
import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {IUniswapV3PoolMinimal} from "../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../src/interfaces/external/IWETH9.sol";
import {IAcrossSpokePool} from "../src/interfaces/external/IAcrossSpokePool.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";
import {GovernanceFixture} from "./utils/GovernanceFixture.sol";

/// @notice Integration: the REAL WarchestGovernance mints decisions through snapshots, votes and finalization; the
///         vault executes them against mocked venue and bridge.
contract WarchestVaultGovernanceTest is GovernanceFixture {
    int24 constant TICK = -197308;
    uint16 constant BPS = 10_000;
    uint32 constant FILL_WINDOW = 4 hours;

    address keeper = makeAddr("keeper");
    address hlAccount = makeAddr("hlAccount");
    MockWETH weth;
    MockUSDG usdg;
    MockUniswapV3Pool pool;
    MockAcrossSpokePool spoke;
    WarchestVault vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployGovernance();
        _defaultVoters();
        _publish(EPOCH);

        weth = new MockWETH();
        usdg = new MockUSDG();
        pool = new MockUniswapV3Pool(address(weth), address(usdg));
        pool.setTicks(TICK);
        usdg.mint(address(pool), 1e12 * 1e6);
        spoke = new MockAcrossSpokePool();
        vault = new WarchestVault(
            guardian,
            keeper,
            IWarchestDecisionSource(address(gov)),
            address(0), // distribution disabled (D7 open)
            WarchestVault.Venue({
                pool: IUniswapV3PoolMinimal(address(pool)), weth: IWETH9(address(weth)), usdg: IERC20(address(usdg))
            }),
            WarchestVault.Bridge({
                spokePool: IAcrossSpokePool(address(spoke)),
                recipient: hlAccount,
                outputToken: makeAddr("usdcHyperEvm"),
                destinationChainId: 999
            }),
            WarchestVault.ConversionParams({
                twapWindow: 30 minutes, maxSlippageBps: 100, maxConvertPerCall: 50 ether, convertCooldown: 10 minutes
            }),
            WarchestVault.OrderParams({
                capBps: 2_000,
                maxBridgeFeeBps: 50,
                maxDecisionAge: 3 days,
                stopLossBps: 500,
                leverage: 3,
                takeProfitBps: 1_000,
                reportChallengeWindow: 6 hours
            })
        );
        vm.prank(guardian);
        gov.setVault(address(vault));

        vm.deal(address(this), 100 ether);
        (bool ok,) = address(vault).call{value: 100 ether}("");
        assertTrue(ok);
        uint256 floor = vault.twapFloor(50 ether);
        vm.prank(keeper);
        vault.convertEthToUsdg(50 ether, floor);
    }

    /// Quorate direction round → decision 1 (ETH short) → executed once.
    function _decideEthShort() internal returns (uint256 roundId) {
        roundId = gov.startDirectionRound(EPOCH);
        _vote(roundId, 0, _opt(1, IWarchestDecisionSource.Side.Short)); // 400 of 1000, quorum is 100
        _vote(roundId, 1, _opt(1, IWarchestDecisionSource.Side.Short));
        vm.warp(gov.getRound(roundId).endsAt);
        gov.finalize(roundId);
    }

    function _execute(uint256 amount) internal {
        vm.prank(keeper);
        vault.executeDecision(
            amount,
            amount * (BPS - 50) / BPS,
            uint32(vm.getBlockTimestamp()),
            uint32(vm.getBlockTimestamp()) + FILL_WINDOW
        );
    }

    function test_governanceDecisionExecutedOnce() public {
        uint256 roundId = _decideEthShort();
        IWarchestDecisionSource.Decision memory d = gov.currentDecision();
        assertEq(d.id, 1);
        assertEq(d.asset, ETH);
        assertEq(uint8(d.side), uint8(IWarchestDecisionSource.Side.Short));
        assertEq(d.roundId, roundId);

        uint256 amount = vault.maxOrderAmount();
        _execute(amount);
        WarchestVault.Position memory p = vault.position();
        assertEq(p.decisionId, 1);
        assertEq(p.asset, ETH);
        assertEq(uint8(p.side), uint8(IWarchestDecisionSource.Side.Short));
        assertEq(p.capital, amount);
        assertEq(usdg.balanceOf(address(spoke)), amount);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionAlreadyExecuted.selector, 1, 1));
        vault.executeDecision(1, 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + FILL_WINDOW);
    }

    /// Quorum missed → same decision id stands (D8) → the vault refuses to re-execute it.
    function test_quorumFallbackDoesNotReopen() public {
        _decideEthShort();
        _execute(1_000e6);

        uint256 r2 = gov.startDirectionRound(EPOCH);
        _vote(r2, 4, _opt(0, IWarchestDecisionSource.Side.Long)); // 50 of 1000 < quorum
        vm.warp(gov.getRound(r2).endsAt);
        gov.finalize(r2);
        assertEq(gov.currentDecision().id, 1);
        assertFalse(vault.mustClose());

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionAlreadyExecuted.selector, 1, 1));
        vault.executeDecision(1, 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + FILL_WINDOW);
    }

    /// A new quorate decision supersedes the open position: the keeper must close first; the new id cannot execute
    /// while the old position is open.
    function test_newDecisionSupersedesOpenPosition() public {
        _decideEthShort();
        _execute(1_000e6);

        uint256 r2 = gov.startDirectionRound(EPOCH);
        _vote(r2, 0, _opt(1, IWarchestDecisionSource.Side.Short)); // same asset & side, still a new id
        vm.warp(gov.getRound(r2).endsAt);
        gov.finalize(r2);
        assertEq(gov.currentDecision().id, 2);
        assertTrue(vault.mustClose());

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.PositionOpen.selector, 1));
        vault.executeDecision(1, 1, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + FILL_WINDOW);
    }

    /// Full cycle on the real governance: decision → order → matured profit report → close vote (allowed only
    /// through `closeVoteAllowed`) → `isCloseRequested` → keeper closes, funds return, close finalized → next
    /// decision on a fresh snapshot executes.
    function test_fullLifecycleWithCloseVote() public {
        _decideEthShort();
        uint256 amount = vault.maxOrderAmount();
        _execute(amount);

        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.CloseVoteNotAllowed.selector, 1));
        gov.startCloseRound(EPOCH);

        vm.prank(keeper);
        vault.reportPosition(1, amount + amount * 2_000 / BPS); // +20%, threshold is +10%
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        assertTrue(vault.closeVoteAllowed(1));

        uint256 closeRound = gov.startCloseRound(EPOCH);
        _vote(closeRound, 0, 1);
        _vote(closeRound, 1, 1);
        vm.warp(gov.getRound(closeRound).endsAt);
        gov.finalize(closeRound);
        assertTrue(gov.isCloseRequested(1));
        assertTrue(vault.mustClose());
        assertFalse(vault.closeVoteAllowed(1));

        vm.prank(keeper);
        vault.reportClosed(1);
        usdg.mint(address(vault), amount + 3_000e6); // bridged back with profit
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        vault.finalizeClose(1);
        assertEq(vault.cumulativePnl(), 3_000e6);
        assertEq(vault.position().decisionId, 0);
        assertEq(vault.distributable(), 3_000e6);

        // the first snapshot is stale by now: publish a new one and decide again
        _publish(EPOCH + 1);
        uint256 r = gov.startDirectionRound(EPOCH + 1);
        _vote(r, 0, _opt(0, IWarchestDecisionSource.Side.Long));
        vm.warp(gov.getRound(r).endsAt);
        gov.finalize(r);
        assertEq(gov.currentDecision().id, 2);
        _execute(1_000e6);
        assertEq(vault.position().decisionId, 2);
        assertEq(vault.position().asset, BTC);
    }

    /// Staleness is judged from the round's `endsAt`.
    function test_staleDecisionCannotExecute() public {
        uint256 roundId = _decideEthShort();
        uint64 endsAt = gov.getRound(roundId).endsAt;
        vm.warp(endsAt + 3 days + 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.DecisionStale.selector, 1, endsAt));
        vault.executeDecision(
            1_000e6, 999e6, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + FILL_WINDOW
        );
    }
}

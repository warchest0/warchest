// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IWarchestDecisionSource} from "../../src/interfaces/IWarchestDecisionSource.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {DeploySystem} from "../../script/DeploySystem.s.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";

/// @notice S3.5 — the whole on-chain cycle on a Robinhood Chain MAINNET fork with the real Uniswap v4 PoolManager,
///         the real WETH/USDG v3 pool and the real Across SpokePool:
///         deploy+wire → trade (10% fee) → flush → ETH→USDG → snapshot → vote → quorum → decision → vault order
///         (real Across deposit) → close report → funds back → PnL → distributor funded & claimed.
///         Only the Hyperliquid leg (off-chain) and the bridge-back fill are simulated.
contract SystemCycleForkTest is Test, DeploySystem {
    address deployer = makeAddr("deployer");
    address multisig = makeAddr("multisig");
    address indexer = makeAddr("indexer");
    address bot = makeAddr("bot");
    address hlAccount = makeAddr("hlAccount");
    address trader = makeAddr("trader");

    address[] voters;
    uint256[] weights;
    System s;
    SystemConfig sys;
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        sys = defaultSystemConfig(multisig, indexer, bot, hlAccount, true);
        Config memory cfg = Config({
            poolManager: IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951),
            positionManager: IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7),
            permit2: IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3),
            vault: address(0),
            name: "Warchest",
            symbol: "WAR",
            supply: 1_000_000_000 ether,
            lpToken: 500_000_000 ether,
            lpEth: 10 ether,
            lpFee: 3000,
            tickSpacing: 60
        });
        vm.deal(deployer, 100 ether);
        vm.startBroadcast(deployer);
        s = deploySystem(sys, cfg, deployer);
        vm.stopBroadcast();

        vm.startPrank(multisig);
        s.governance.acceptGuardian();
        s.vault.acceptGuardian();
        s.distributor.acceptGuardian();
        vm.stopPrank();

        for (uint256 i; i < 4; ++i) {
            voters.push(makeAddr(string.concat("holder", vm.toString(i))));
        }
        weights = [uint256(4_000e18), 3_000e18, 2_000e18, 1_000e18];
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _leaves(uint64 epoch) internal view returns (bytes32[] memory l) {
        l = new bytes32[](voters.length);
        for (uint256 i; i < voters.length; ++i) {
            l[i] = s.governance.leaf(epoch, voters[i], weights[i]);
        }
    }

    function _publishSnapshot() internal returns (uint64 epoch) {
        epoch = uint64(_now() / 1 days);
        bytes32 root = MerkleHelper.root(_leaves(epoch));
        vm.prank(indexer);
        s.governance.submitWeightRoot(epoch, root, 10_000e18, keccak256("tree"));
        vm.warp(_now() + 6 hours);
    }

    function _vote(uint256 roundId, uint64 epoch, uint256 i, uint256 option) internal {
        bytes32[] memory p = MerkleHelper.proof(_leaves(epoch), i);
        vm.prank(voters[i]);
        s.governance.vote(roundId, option, weights[i], p);
    }

    function _execute() internal returns (uint256 amount) {
        amount = s.vault.maxOrderAmount();
        uint32 ts = uint32(_now());
        vm.prank(bot);
        s.vault.executeDecision(amount, amount * 9_960 / 10_000, ts, ts + 4 hours);
    }

    function test_fullCycle() public {
        if (!forked) vm.skip(true);

        // 1. wiring
        assertEq(s.governance.vault(), address(s.vault));
        assertEq(s.launch.hook.vault(), address(s.vault));
        assertEq(address(s.distributor.vault()), address(s.vault));
        assertEq(s.vault.guardian(), multisig);
        assertEq(s.governance.guardian(), multisig);

        // 2. trading pays 10% in ETH to the vault
        PoolSwapTest router = new PoolSwapTest(IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951));
        vm.deal(trader, 20 ether);
        vm.prank(trader);
        router.swap{value: 20 ether}(
            s.launch.key,
            SwapParams(true, -20 ether, TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        s.launch.hook.flush();
        assertEq(address(s.vault).balance, 2 ether - 1);

        // 3. keeper converts the fees at no worse than TWAP − 1%
        uint256 ethIn = address(s.vault).balance;
        uint256 floor = s.vault.twapFloor(ethIn);
        vm.prank(bot);
        uint256 usdgOut = s.vault.convertEthToUsdg(ethIn, floor);
        assertGe(usdgOut, floor);
        console2.log("fees converted to USDG (6 dec)", usdgOut);

        // 4. snapshot, vote, quorum → decision 1 = ETH (asset 1) LONG
        uint64 epoch = _publishSnapshot();
        uint256 roundId = s.governance.startDirectionRound(epoch);
        _vote(roundId, epoch, 0, 2); // 40% ETH long
        _vote(roundId, epoch, 1, 1); // 30% BTC short
        vm.warp(_now() + 1 days);
        s.governance.finalize(roundId);
        IWarchestDecisionSource.Decision memory d = s.governance.currentDecision();
        assertEq(d.id, 1);
        assertEq(d.asset, 1);
        assertEq(uint8(d.side), uint8(IWarchestDecisionSource.Side.Long));

        // 5. vault order: ≤ 20% of NAV, real Across deposit to the immutable HL account
        uint256 navBefore = s.vault.nav();
        IERC20 usdg = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
        uint256 spokeBefore = usdg.balanceOf(0xD29C85F15DF544bA632C9E25829fd29d767d7978);
        uint256 capital = _execute();
        assertLe(capital, navBefore * 2_000 / 10_000);
        assertEq(usdg.balanceOf(0xD29C85F15DF544bA632C9E25829fd29d767d7978), spokeBefore + capital);
        assertEq(s.vault.position().decisionId, 1);

        // 6. D8: a quorum-less round keeps decision 1 (same id) → nothing new to execute
        epoch = _publishSnapshot();
        roundId = s.governance.startDirectionRound(epoch);
        vm.warp(_now() + 1 days);
        s.governance.finalize(roundId); // nobody voted
        assertEq(s.governance.currentDecision().id, 1);
        assertFalse(s.vault.mustClose());

        //    a quorate round for another trade supersedes it → the open position must be closed first
        epoch = _publishSnapshot();
        roundId = s.governance.startDirectionRound(epoch);
        _vote(roundId, epoch, 3, 0); // 10% = exactly the quorum, BTC long
        vm.warp(_now() + 1 days);
        s.governance.finalize(roundId);
        assertEq(s.governance.currentDecision().id, 2);
        assertTrue(s.vault.mustClose(), "superseded position must be closed");

        // 7. close on Hyperliquid (simulated): keeper reports, +25% comes back via the bridge
        vm.prank(bot);
        s.vault.reportClosed(1);
        deal(address(usdg), address(s.vault), usdg.balanceOf(address(s.vault)) + capital * 125 / 100);
        vm.warp(_now() + 6 hours);
        s.vault.finalizeClose(1);
        assertEq(s.vault.cumulativePnl(), int256(capital * 25 / 100));

        // 8. profit above the high-water mark reaches holders
        uint256 funded = s.distributor.fund();
        assertEq(funded, capital * 25 / 100);
        bytes32[] memory l = new bytes32[](2);
        uint256 half = funded / 2;
        l[0] = s.distributor.leaf(voters[0], half);
        l[1] = s.distributor.leaf(voters[1], funded - half);
        vm.prank(indexer);
        s.distributor.proposeRoot(MerkleHelper.root(l), funded, keccak256("dist"));
        vm.warp(_now() + 1 days);
        s.distributor.acceptRoot();
        s.distributor.claim(voters[0], half, MerkleHelper.proof(l, 0));
        assertEq(usdg.balanceOf(voters[0]), half);
    }
}

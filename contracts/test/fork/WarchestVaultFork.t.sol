// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {IWarchestDecisionSource} from "../../src/interfaces/IWarchestDecisionSource.sol";
import {IUniswapV3PoolMinimal, IUniswapV3SwapCallback} from "../../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../../src/interfaces/external/IWETH9.sol";
import {IAcrossSpokePool} from "../../src/interfaces/external/IAcrossSpokePool.sol";
import {MockDecisionSource} from "../mocks/MockDecisionSource.sol";

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @notice Sells ETH into the real pool from another account (sandwich / price-push simulation).
contract ForkSwapper is IUniswapV3SwapCallback {
    IUniswapV3PoolMinimal immutable pool;
    IWETH9 immutable weth;

    constructor(IUniswapV3PoolMinimal pool_, IWETH9 weth_) {
        pool = pool_;
        weth = weth_;
    }

    function sellEth(uint256 amount) external payable {
        weth.deposit{value: amount}();
        pool.swap(address(this), true, int256(amount), TickMath.MIN_SQRT_PRICE + 1, "");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256, bytes calldata) external {
        require(msg.sender == address(pool));
        if (amount0Delta > 0) weth.transfer(address(pool), uint256(amount0Delta));
    }
}

/// @notice Vault deployed on the REAL Uniswap v3 0.01% WETH/USDG pool, WETH, USDG and Across SpokePool of a
///         Robinhood Chain mainnet fork. Governance is mocked (its own suites cover it).
/// @dev Requires `ROBINHOOD_RPC_URL`; the suites built on it are skipped when it is unset.
abstract contract WarchestVaultForkFixture is Test {
    IUniswapV3PoolMinimal constant POOL = IUniswapV3PoolMinimal(0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca);
    IWETH9 constant WETH = IWETH9(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IQuoterV2 constant QUOTER = IQuoterV2(0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7);
    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    IAcrossSpokePool constant SPOKE = IAcrossSpokePool(0xD29C85F15DF544bA632C9E25829fd29d767d7978);
    address constant USDC_HYPEREVM = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    uint256 constant HYPEREVM_CHAIN_ID = 999;

    uint32 constant TWAP_WINDOW = 30 minutes;
    uint16 constant MAX_SLIPPAGE_BPS = 100;
    uint256 constant MAX_CONVERT = 50 ether;
    uint64 constant COOLDOWN = 10 minutes;
    uint16 constant BPS = 10_000;

    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address hlAccount = makeAddr("hlAccount");
    bool forked;
    MockDecisionSource gov;
    WarchestVault vault;
    /// |30 min TWAP − 6 h TWAP| at the fork block, before any settling (see {_settleOracle}).
    uint256 rawDeviationAtFork;

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        gov = new MockDecisionSource();
        vault = new WarchestVault(
            guardian,
            keeper,
            IWarchestDecisionSource(address(gov)),
            address(0), // distribution disabled (D7 open)
            WarchestVault.Venue({pool: POOL, weth: WETH, usdg: USDG}),
            WarchestVault.Bridge({
                spokePool: SPOKE,
                recipient: hlAccount,
                outputToken: USDC_HYPEREVM,
                destinationChainId: HYPEREVM_CHAIN_ID
            }),
            WarchestVault.ConversionParams({
                twapWindow: TWAP_WINDOW,
                maxSlippageBps: MAX_SLIPPAGE_BPS,
                maxConvertPerCall: MAX_CONVERT,
                convertCooldown: COOLDOWN
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
        _settleOracle();
    }

    /// The fork is the live market: if ETH moved more than the breaker's tolerance between the 30 min and the 6 h
    /// TWAP at the fork block, the breaker is (correctly) tripped and every conversion would wait. Let the oracle
    /// settle on the current price so the conversion tests run in normal conditions; the raw state is logged.
    function _settleOracle() internal {
        int24 short_ = vault.twapTick();
        int24 long_ = vault.longTwapTick();
        rawDeviationAtFork = uint256(uint24(short_ > long_ ? short_ - long_ : long_ - short_));
        if (!vault.oracleStable()) {
            console2.log("oracle breaker tripped at the fork block, deviation (ticks)", rawDeviationAtFork);
            vm.warp(vm.getBlockTimestamp() + vault.LONG_TWAP_WINDOW());
            assertTrue(vault.oracleStable(), "TWAPs must agree once the price has been constant for 6 h");
        }
    }

    function _fund(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok,) = address(vault).call{value: amount}("");
        assertTrue(ok);
    }

    function _cool() internal {
        vm.cool(address(vault));
        vm.cool(address(POOL));
        vm.cool(address(WETH));
        vm.cool(address(USDG));
        vm.cool(address(SPOKE));
        vm.cool(address(gov));
    }

    function _bytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    receive() external payable {}
}

/// @notice S3.1–S3.2 on the real venue and bridge.
contract WarchestVaultForkTest is WarchestVaultForkFixture {
    // ---------------------------------------------------------------------------------------------------------------
    // S3.1 — venue & conversion
    // ---------------------------------------------------------------------------------------------------------------

    function test_fork_venueWiring() public onlyFork {
        assertEq(block.chainid, 4663);
        assertEq(POOL.token0(), address(WETH));
        assertEq(POOL.token1(), address(USDG));
        assertEq(POOL.fee(), 100);
        assertEq(IERC20Metadata(address(USDG)).decimals(), 6);
        assertEq(IERC20Metadata(address(WETH)).decimals(), 18);
        assertGt(SWAP_ROUTER_02.code.length, 0, "SwapRouter02 documented but unused");
    }

    /// The pool oracle keeps far more than 30 min of history; the TWAP is close to spot in normal conditions.
    function test_fork_oracleHistoryAndTwap() public onlyFork {
        (, int24 spot,, uint16 cardinality,,,) = POOL.slot0();
        int24 twap = vault.twapTick();
        console2.log("observationCardinality", cardinality);
        console2.log("spot tick / 30m TWAP tick");
        console2.logInt(spot);
        console2.logInt(twap);
        assertGt(cardinality, 1_000);
        int256 diff = int256(spot) - int256(twap);
        assertLt(diff < 0 ? -diff : diff, 1_000, "TWAP more than 10% away from spot?");

        // the vault needs LONG_TWAP_WINDOW (6 h) of history; the real depth varies with pool activity
        // (≈ 44 h on 2026-09-27, ≈ 11 h on 2026-09-28) — see script/ExtendOracleHistory.s.sol
        uint32[] memory ago = new uint32[](2);
        ago[0] = uint32(vault.LONG_TWAP_WINDOW());
        ago[1] = 0;
        POOL.observe(ago); // must not revert "OLD"

        uint256 q = vault.quoteEthInUsdg(1 ether);
        console2.log("TWAP quote 1 ETH (USDG, 6 dec)", q);
        assertGt(q, 100e6);
        assertLt(q, 100_000e6);
    }

    /// The vault's direct pool swap returns exactly what the official QuoterV2 predicts for the same block.
    function test_fork_convertOneEthMatchesQuoter() public onlyFork {
        _fund(1 ether);
        (uint256 quoted,,,) = QUOTER.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: address(WETH), tokenOut: address(USDG), amountIn: 1 ether, fee: 100, sqrtPriceLimitX96: 0
            })
        );
        uint256 floor = vault.twapFloor(1 ether);
        console2.log("QuoterV2 1 ETH -> USDG", quoted);
        console2.log("TWAP floor           ", floor);

        vm.prank(keeper);
        uint256 out = vault.convertEthToUsdg(1 ether, floor);
        assertEq(out, quoted);
        assertGe(out, floor);
        assertEq(USDG.balanceOf(address(vault)), out);
        assertEq(vault.usdgLedger(), out);
        assertEq(WETH.balanceOf(address(vault)), 0);
        assertEq(address(vault).balance, 0);
        assertEq(USDG.allowance(address(vault), address(POOL)), 0);
    }

    function test_fork_convertTenEth_gas() public onlyFork {
        _fund(10 ether);
        uint256 floor = vault.twapFloor(10 ether);
        _cool();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        uint256 out = vault.convertEthToUsdg(10 ether, floor);
        uint256 gas = g0 - gasleft();
        console2.log("convertEthToUsdg(10 ETH) gas", gas);
        console2.log("USDG out", out);
        assertGe(out, floor);
        // live-chain dependent (ticks crossed, cold slots): generous bound, the point is the order of magnitude
        assertLt(gas, 600_000);
    }

    function test_fork_maxPerCall() public onlyFork {
        _fund(MAX_CONVERT);
        uint256 floor = vault.twapFloor(MAX_CONVERT);
        vm.prank(keeper);
        uint256 out = vault.convertEthToUsdg(MAX_CONVERT, floor);
        console2.log("50 ETH -> USDG", out);
        assertGe(out, floor);
    }

    function test_fork_rejectsMinOutBelowFloor() public onlyFork {
        _fund(1 ether);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.MinOutBelowFloor.selector, floor - 1, floor));
        vault.convertEthToUsdg(1 ether, floor - 1);
    }

    /// A third party dumps ETH into the pool right before the keeper converts: spot falls under the TWAP floor and
    /// the conversion reverts instead of selling cheap. The keeper cannot lower `minOut` to get through.
    function test_fork_sandwichedSpotRejected() public onlyFork {
        _fund(1 ether);
        int24 twap = vault.twapTick();
        ForkSwapper attacker = new ForkSwapper(POOL, WETH);
        vm.deal(address(attacker), 20_000 ether);
        int24 spot;
        for (uint256 i; i < 8; ++i) {
            attacker.sellEth(2_000 ether);
            (, spot,,,,,) = POOL.slot0();
            if (spot < twap - 150) break;
        }
        console2.log("spot after dump / TWAP");
        console2.logInt(spot);
        console2.logInt(twap);
        assertLt(spot, twap - 150, "could not push the price 1.5% under the TWAP");
        // the 30-minute TWAP barely moved (same block)
        assertEq(vault.twapTick(), twap);

        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vm.expectRevert();
        vault.convertEthToUsdg(1 ether, floor);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(WarchestVault.MinOutBelowFloor.selector, 0, floor));
        vault.convertEthToUsdg(1 ether, 0);
        assertEq(address(vault).balance, 1 ether);
        assertEq(USDG.balanceOf(address(vault)), 0);
    }

    /// Real WETH proxy on Robinhood Chain: deposit/withdraw/transfer behave as WETH9.
    function test_fork_realWethRoundTrip() public onlyFork {
        vm.deal(address(this), 1 ether);
        WETH.deposit{value: 1 ether}();
        assertEq(WETH.balanceOf(address(this)), 1 ether);
        WETH.withdraw(1 ether);
        assertEq(address(this).balance, 1 ether);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // S3.2 — real Across SpokePool
    // ---------------------------------------------------------------------------------------------------------------

    function test_fork_spokePoolWiring() public onlyFork {
        assertEq(SPOKE.depositQuoteTimeBuffer(), 3600);
        assertEq(SPOKE.fillDeadlineBuffer(), 21_600);
        assertEq(SPOKE.getCurrentTime(), vm.getBlockTimestamp());
        console2.log("SpokePool numberOfDeposits", SPOKE.numberOfDeposits());
    }

    /// Full outbound path on the real contracts: ETH → USDG on the v3 pool, then `deposit(bytes32,…)` on the Across
    /// SpokePool for the immutable recipient on HyperEVM (999), USDC out.
    function test_fork_executeDecision_realSpokePool() public onlyFork {
        _fund(10 ether);
        uint256 floor = vault.twapFloor(10 ether);
        vm.prank(keeper);
        vault.convertEthToUsdg(10 ether, floor);
        uint256 id = gov.nextDecision(0, IWarchestDecisionSource.Side.Long);

        uint256 amount = vault.maxOrderAmount(); // 20% of ≈ 27 000 USDG
        uint256 out = amount * (BPS - 10) / BPS; // 10 bp bridge fee, like the live quotes (RESEARCH.md §3.2: ~6 bp)
        uint32 depositId = SPOKE.numberOfDeposits();
        uint256 spokeBefore = USDG.balanceOf(address(SPOKE));
        uint32 quoteTs = uint32(vm.getBlockTimestamp());
        uint32 fillDeadline = uint32(vm.getBlockTimestamp()) + 4 hours;
        console2.log("bridging USDG", amount);

        vm.expectEmit(true, true, true, true, address(SPOKE));
        emit IAcrossSpokePool.FundsDeposited(
            _bytes32(address(USDG)),
            _bytes32(USDC_HYPEREVM),
            amount,
            out,
            HYPEREVM_CHAIN_ID,
            depositId,
            quoteTs,
            fillDeadline,
            0,
            _bytes32(address(vault)),
            _bytes32(hlAccount),
            bytes32(0),
            ""
        );
        _cool();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        vault.executeDecision(amount, out, quoteTs, fillDeadline);
        console2.log("executeDecision gas (real SpokePool)", g0 - gasleft());

        assertEq(SPOKE.numberOfDeposits(), depositId + 1);
        assertEq(USDG.balanceOf(address(SPOKE)), spokeBefore + amount);
        assertEq(USDG.allowance(address(vault), address(SPOKE)), 0);
        WarchestVault.Position memory p = vault.position();
        assertEq(p.decisionId, id);
        assertEq(p.capital, amount);
        assertEq(p.depositId, depositId);
        assertEq(vault.usdgLedger(), USDG.balanceOf(address(vault)));
    }

    function test_fork_executeDecision_spokeRejectsBadTimestamps() public onlyFork {
        _fund(1 ether);
        uint256 floor = vault.twapFloor(1 ether);
        vm.prank(keeper);
        vault.convertEthToUsdg(1 ether, floor);
        gov.nextDecision(0, IWarchestDecisionSource.Side.Long);
        uint256 amount = 100e6;
        vm.prank(keeper);
        vm.expectRevert(); // InvalidQuoteTimestamp in the real SpokePool
        vault.executeDecision(
            amount, amount, uint32(vm.getBlockTimestamp()) + 1, uint32(vm.getBlockTimestamp()) + 4 hours
        );
        vm.prank(keeper);
        vm.expectRevert(); // InvalidFillDeadline in the real SpokePool
        vault.executeDecision(amount, amount, uint32(vm.getBlockTimestamp()), uint32(vm.getBlockTimestamp()) + 21_601);
        assertEq(vault.position().decisionId, 0);
        assertEq(vault.lastExecutedDecisionId(), 0);
    }
}

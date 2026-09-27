// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {WarchestVault} from "../../src/WarchestVault.sol";
import {IUniswapV3PoolMinimal, IUniswapV3SwapCallback} from "../../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../../src/interfaces/external/IWETH9.sol";

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

/// @notice S3.1 against the REAL Uniswap v3 0.01% WETH/USDG pool, WETH and USDG on a Robinhood Chain mainnet fork.
/// @dev Requires `ROBINHOOD_RPC_URL`; the whole suite is skipped when it is unset.
contract WarchestVaultForkTest is Test {
    IUniswapV3PoolMinimal constant POOL = IUniswapV3PoolMinimal(0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca);
    IWETH9 constant WETH = IWETH9(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IQuoterV2 constant QUOTER = IQuoterV2(0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7);
    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;

    uint32 constant TWAP_WINDOW = 30 minutes;
    uint16 constant MAX_SLIPPAGE_BPS = 100;
    uint256 constant MAX_CONVERT = 50 ether;
    uint64 constant COOLDOWN = 10 minutes;

    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    bool forked;
    WarchestVault vault;

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        vault = new WarchestVault(
            guardian,
            keeper,
            WarchestVault.Venue({pool: POOL, weth: WETH, usdg: USDG}),
            WarchestVault.ConversionParams({
                twapWindow: TWAP_WINDOW,
                maxSlippageBps: MAX_SLIPPAGE_BPS,
                maxConvertPerCall: MAX_CONVERT,
                convertCooldown: COOLDOWN
            })
        );
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
    }

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

        uint32[] memory ago = new uint32[](2);
        ago[0] = 24 hours;
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
        assertLt(gas, 400_000);
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

    receive() external payable {}
}

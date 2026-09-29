// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3SwapCallback} from "../../interfaces/external/IUniswapV3PoolMinimal.sol";

// TESTNET ONLY. Robinhood Chain testnet (46630) has no WETH, no USDG and no Uniswap v3 WETH/USDG pool, which the
// vault needs (RESEARCH.md; DECISIONS.md D6). These stand-ins let the whole system run end to end on testnet.
// Never deploy them on mainnet.

/// @notice WETH9-compatible wrapped ether for testnet.
contract TestnetWETH is ERC20 {
    constructor() ERC20("Wrapped Ether (testnet)", "WETH") {}

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "TestnetWETH: send failed");
    }

    receive() external payable {
        deposit();
    }
}

/// @notice 6-decimal dollar token standing in for USDG on testnet. The owner can mint.
contract TestnetUSDG is ERC20 {
    address public immutable owner;

    constructor(address owner_) ERC20("Global Dollar (testnet)", "USDG") {
        owner = owner_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "TestnetUSDG: not owner");
        _mint(to, amount);
    }
}

/// @notice Uniswap-v3-shaped WETH/USDG pool for testnet: the owner sets the price tick (e.g. from a mainnet feed);
///         the oracle reports that tick over every window and swaps (exact input WETH → USDG, the only path the vault
///         uses) fill at it from the pool's USDG reserve. Exposes exactly the calls the vault makes.
contract TestnetOraclePool {
    address public immutable token0; // WETH
    address public immutable token1; // USDG
    address public immutable owner;
    int24 public tick;

    event TickSet(int24 tick);

    constructor(address weth, address usdg, int24 tick_, address owner_) {
        token0 = weth;
        token1 = usdg;
        owner = owner_;
        tick = tick_;
    }

    function setTick(int24 tick_) external {
        require(msg.sender == owner, "TestnetOraclePool: not owner");
        tick = tick_;
        emit TickSet(tick_);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (TickMath.getSqrtPriceAtTick(tick), tick, 0, type(uint16).max, type(uint16).max, 0, true);
    }

    /// @dev Constant tick ⇒ cumulative(t) = tick × t; the mean over any window is `tick`, never "OLD".
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory cum, uint160[] memory spl) {
        cum = new int56[](secondsAgos.length);
        spl = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            cum[i] = int56(tick) * int56(int256(block.timestamp) - int256(uint256(secondsAgos[i])));
        }
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(zeroForOne && amountSpecified > 0, "TestnetOraclePool: exact input WETH->USDG only");
        uint256 out = quote(uint256(amountSpecified));
        amount0 = amountSpecified;
        amount1 = -int256(out);
        require(IERC20(token1).transfer(recipient, out), "TestnetOraclePool: reserve too low");
        uint256 before = IERC20(token0).balanceOf(address(this));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(token0).balanceOf(address(this)) >= before + uint256(amountSpecified), "IIA");
    }

    /// @notice USDG out for `amount0` WETH at the current tick (Uniswap OracleLibrary.getQuoteAtTick).
    function quote(uint256 amount0) public view returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            return Math.mulDiv(amount0, uint256(sqrtPriceX96) * sqrtPriceX96, uint256(1) << 192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, uint256(1) << 64);
        return Math.mulDiv(amount0, ratioX128, uint256(1) << 128);
    }
}

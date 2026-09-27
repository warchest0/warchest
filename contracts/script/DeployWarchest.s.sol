// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {WarchestToken} from "../src/WarchestToken.sol";
import {WarchestHook} from "../src/WarchestHook.sol";
import {DeployWarchestHook} from "./DeployWarchestHook.s.sol";

/// @title DeployWarchest
/// @notice Full launch sequence: token → hook (mined CREATE2) → direct `PoolManager.initialize` → full-range
///         liquidity through the official PositionManager. The broadcaster is the token recipient, the pool
///         initializer and the LP owner.
/// @dev Uniswap v4 is deployed at the SAME addresses on Robinhood mainnet (4663) and testnet (46630).
///      Environment variables (defaults in brackets):
///      - `WARCHEST_VAULT`     fee recipient (immutable in the hook) — required
///      - `POOL_MANAGER`       [0x8366a39CC670B4001A1121B8F6A443A643e40951]
///      - `POSITION_MANAGER`   [0x58daec3116aae6D93017bAAea7749052E8a04fA7]
///      - `PERMIT2`            [0x000000000022D473030F116dDEE9F6B43aC78BA3]
///      - `TOKEN_NAME` ["Warchest"], `TOKEN_SYMBOL` ["WAR"], `TOKEN_SUPPLY` [1e9 ether]
///      - `LP_TOKEN_AMOUNT`    tokens seeded in the pool [TOKEN_SUPPLY]
///      - `LP_ETH_AMOUNT`      ETH seeded in the pool [1 ether]
///      - `LP_FEE` [3000], `TICK_SPACING` [60]
///
///      `forge script script/DeployWarchest.s.sol --rpc-url robinhood_testnet --broadcast --verify`
contract DeployWarchest is DeployWarchestHook {
    struct Config {
        IPoolManager poolManager;
        IPositionManager positionManager;
        IAllowanceTransfer permit2;
        address vault;
        string name;
        string symbol;
        uint256 supply;
        uint256 lpToken;
        uint256 lpEth;
        uint24 lpFee;
        int24 tickSpacing;
    }

    struct Deployment {
        WarchestToken token;
        WarchestHook hook;
        PoolKey key;
        uint160 sqrtPriceX96;
        uint256 positionId;
    }

    error LpAmountExceedsSupply();

    function run() external virtual override returns (WarchestHook) {
        Config memory cfg = loadConfig();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Deployment memory d = launch(cfg, deployer);
        vm.stopBroadcast();

        console2.log("chainId        ", block.chainid);
        console2.log("WarchestToken  ", address(d.token));
        console2.log("WarchestHook   ", address(d.hook));
        console2.log("vault          ", cfg.vault);
        console2.log("LP position id ", d.positionId);
        console2.log("poolId");
        console2.logBytes32(keccak256(abi.encode(d.key)));
        return d.hook;
    }

    function loadConfig() public view returns (Config memory cfg) {
        cfg = loadConfigWithVault(vm.envAddress("WARCHEST_VAULT"));
    }

    /// @notice Same as {loadConfig} but with an explicit fee recipient (used by DeploySystem).
    function loadConfigWithVault(address vault) public view returns (Config memory cfg) {
        cfg.poolManager = IPoolManager(vm.envOr("POOL_MANAGER", 0x8366a39CC670B4001A1121B8F6A443A643e40951));
        cfg.positionManager = IPositionManager(vm.envOr("POSITION_MANAGER", 0x58daec3116aae6D93017bAAea7749052E8a04fA7));
        cfg.permit2 = IAllowanceTransfer(vm.envOr("PERMIT2", 0x000000000022D473030F116dDEE9F6B43aC78BA3));
        cfg.vault = vault;
        cfg.name = vm.envOr("TOKEN_NAME", string("Warchest"));
        cfg.symbol = vm.envOr("TOKEN_SYMBOL", string("WAR"));
        cfg.supply = vm.envOr("TOKEN_SUPPLY", uint256(1_000_000_000 ether));
        cfg.lpToken = vm.envOr("LP_TOKEN_AMOUNT", cfg.supply);
        cfg.lpEth = vm.envOr("LP_ETH_AMOUNT", uint256(1 ether));
        cfg.lpFee = uint24(vm.envOr("LP_FEE", uint256(3000)));
        cfg.tickSpacing = int24(int256(vm.envOr("TICK_SPACING", uint256(60))));
    }

    /// @notice Executes the launch as `deployer` (must be the broadcaster / current msg.sender of calls).
    function launch(Config memory cfg, address deployer) public returns (Deployment memory d) {
        if (cfg.lpToken > cfg.supply) revert LpAmountExceedsSupply();

        d.token = new WarchestToken(cfg.name, cfg.symbol, cfg.supply, deployer);

        (, bytes32 salt) = mine(cfg.poolManager, address(d.token), cfg.vault, deployer);
        d.hook = deploy(salt, cfg.poolManager, address(d.token), cfg.vault, deployer);

        d.key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(d.token)),
            fee: cfg.lpFee,
            tickSpacing: cfg.tickSpacing,
            hooks: IHooks(address(d.hook))
        });
        d.sqrtPriceX96 = sqrtPriceX96For(cfg.lpToken, cfg.lpEth);
        // must be called directly by the initializer (the hook checks `sender == initializer`)
        cfg.poolManager.initialize(d.key, d.sqrtPriceX96);

        d.positionId = _addFullRangeLiquidity(cfg, d, deployer);
    }

    /// @notice sqrt(price) in Q64.96 where price = token1 per token0 = tokens per ETH.
    function sqrtPriceX96For(uint256 tokenAmount, uint256 ethAmount) public pure returns (uint160) {
        // sqrt(token * 2^96 / eth) * 2^48 == sqrt(token / eth) * 2^96 without overflowing for realistic supplies
        return uint160(Math.sqrt(Math.mulDiv(tokenAmount, 1 << 96, ethAmount)) << 48);
    }

    function _addFullRangeLiquidity(Config memory cfg, Deployment memory d, address owner)
        internal
        returns (uint256 positionId)
    {
        int24 lower = TickMath.minUsableTick(cfg.tickSpacing);
        int24 upper = TickMath.maxUsableTick(cfg.tickSpacing);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            d.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            cfg.lpEth,
            cfg.lpToken
        );

        IERC20(address(d.token)).approve(address(cfg.permit2), type(uint256).max);
        cfg.permit2.approve(address(d.token), address(cfg.positionManager), type(uint160).max, type(uint48).max);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(d.key, lower, upper, liquidity, uint128(cfg.lpEth), uint128(cfg.lpToken), owner, "");
        params[1] = abi.encode(d.key.currency0, d.key.currency1);
        params[2] = abi.encode(d.key.currency0, owner); // refund unused ETH

        positionId = cfg.positionManager.nextTokenId();
        cfg.positionManager.modifyLiquidities{value: cfg.lpEth}(abi.encode(actions, params), block.timestamp + 600);
    }
}

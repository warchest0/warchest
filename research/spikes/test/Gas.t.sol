// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// SPIKE S0.1 — real gas measurement on a Robinhood Chain mainnet fork (official v4 PoolManager).

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TestERC20} from "@uniswap/v4-core/src/test/TestERC20.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {SpikeFeeHook} from "../src/SpikeFeeHook.sol";
import {MerkleVoting, PerWalletLevels, OnchainLots} from "../src/SpikeBench.sol";

contract SwapGasTest is Test {
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    address constant VAULT = address(0x7A17);

    PoolSwapTest router;
    PoolModifyLiquidityTest lpRouter;
    TestERC20 token;
    PoolKey hooked;
    PoolKey plain;

    function setUp() public {
        vm.createSelectFork("robinhood");
        router = new PoolSwapTest(MANAGER);
        lpRouter = new PoolModifyLiquidityTest(MANAGER);
        token = new TestERC20(1e30);
        token.approve(address(router), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);

        uint160 flags = Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        address hookAddr = address(uint160(0x4444000000000000000000000000000000000000) | flags);
        deployCodeTo("SpikeFeeHook.sol:SpikeFeeHook", abi.encode(MANAGER, VAULT), hookAddr);

        hooked = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(hookAddr));
        plain = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(address(0)));
        vm.deal(address(this), 10_000 ether);
        for (uint256 i; i < 2; ++i) {
            PoolKey memory k = i == 0 ? hooked : plain;
            MANAGER.initialize(k, SQRT_PRICE_1_1);
            lpRouter.modifyLiquidity{value: 3_000 ether}(
                k, ModifyLiquidityParams(-6000, 6000, 10_000 ether, 0), ""
            );
        }
    }

    function _swap(PoolKey memory k, bool zeroForOne, int256 amount) internal returns (uint256 used) {
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        uint256 value = zeroForOne ? 5 ether : 0;
        uint256 g = gasleft();
        router.swap{value: value}(k, SwapParams(zeroForOne, amount, limit), PoolSwapTest.TestSettings(false, false), "");
        used = g - gasleft();
    }

    function _case(string memory name, bool zeroForOne, int256 amount) internal {
        uint256 snap = vm.snapshotState();
        uint256 v0 = VAULT.balance;
        uint256 withHook = _swap(hooked, zeroForOne, amount);
        uint256 fee = VAULT.balance - v0;
        vm.revertToState(snap);
        uint256 without = _swap(plain, zeroForOne, amount);
        console2.log(name);
        console2.log("  gas with hook   ", withHook);
        console2.log("  gas without hook", without);
        console2.log("  hook overhead   ", withHook - without);
        console2.log("  fee to vault wei", fee);
        assertGt(fee, 0);
    }

    function test_buy_exactIn() public { _case("BUY exactIn 1 ETH", true, -1 ether); }
    function test_buy_exactOut() public { _case("BUY exactOut 1 TOKEN", true, 1 ether); }
    function test_sell_exactIn() public { _case("SELL exactIn 1 TOKEN", false, -1 ether); }
    function test_sell_exactOut() public { _case("SELL exactOut 0.5 ETH", false, 0.5 ether); }

    receive() external payable {}
}

contract GovernanceGasTest is Test {
    function _proof(uint256 depth, bytes32 leaf) internal pure returns (bytes32[] memory proof, bytes32 root) {
        proof = new bytes32[](depth);
        root = leaf;
        for (uint256 i; i < depth; ++i) {
            proof[i] = keccak256(abi.encode("sibling", i));
            root = Hashes.commutativeKeccak256(root, proof[i]);
        }
    }

    function _vote(uint256 depth) internal returns (uint256 used) {
        MerkleVoting mv = new MerkleVoting();
        address voter = address(0xBEEF);
        uint256 weight = 123e18;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(uint256(1), voter, weight))));
        (bytes32[] memory proof, bytes32 root) = _proof(depth, leaf);
        uint256 g = gasleft();
        mv.submitRoot(1, root);
        console2.log("submitRoot gas", g - gasleft());
        vm.cool(address(mv));
        vm.prank(voter);
        g = gasleft();
        mv.vote(1, 0, weight, proof);
        used = g - gasleft();
    }

    function test_vote_depth17_100k_holders() public { console2.log("vote gas depth 17", _vote(17)); }
    function test_vote_depth20_1M_holders() public { console2.log("vote gas depth 20", _vote(20)); }

    function _batch(uint256 n) internal returns (uint256 newGas, uint256 updGas) {
        PerWalletLevels p = new PerWalletLevels();
        address[] memory w = new address[](n);
        uint8[] memory l = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            w[i] = address(uint160(0x1000 + i));
            l[i] = 1;
        }
        uint256 g = gasleft();
        p.setLevels(w, l);
        newGas = g - gasleft();
        for (uint256 i; i < n; ++i) l[i] = 2;
        vm.cool(address(p));
        g = gasleft();
        p.setLevels(w, l);
        updGas = g - gasleft();
    }

    function test_levels_batch_1000() public {
        (uint256 a, uint256 b) = _batch(1000);
        console2.log("setLevels 1000 new", a);
        console2.log("setLevels 1000 upd", b);
    }

    function test_levels_batch_10000() public {
        (uint256 a, uint256 b) = _batch(10_000);
        console2.log("setLevels 10000 new", a);
        console2.log("setLevels 10000 upd", b);
    }
}

contract LotsGasTest is Test {
    OnchainLots lots;
    address constant W = address(0xA11CE);

    function _fill(uint256 n) internal returns (uint256 buyGas) {
        lots = new OnchainLots();
        vm.cool(address(lots));
        uint256 g = gasleft();
        lots.buy(W, 1e18);
        buyGas = g - gasleft();
        for (uint256 i = 1; i < n; ++i) {
            vm.warp(block.timestamp + 1 hours);
            lots.buy(W, 1e18);
        }
        vm.warp(block.timestamp + 11 days);
        vm.cool(address(lots));
    }

    function test_lifo_sell_1_lot() public {
        _fill(500);
        uint256 g = gasleft();
        lots.sellLifo(W, 1e18);
        console2.log("LIFO sell consuming 1 lot (of 500)", g - gasleft());
    }

    function test_lifo_sell_500_lots_worst_case() public {
        uint256 b = _fill(500);
        console2.log("buy (push 1 lot)", b);
        uint256 g = gasleft();
        lots.sellLifo(W, 500e18);
        console2.log("LIFO sell consuming 500 lots", g - gasleft());
    }

    function test_fifo_sell_500_lots_worst_case() public {
        _fill(500);
        uint256 g = gasleft();
        lots.sellFifo(W, 500e18);
        console2.log("FIFO sell consuming 500 lots", g - gasleft());
    }

    function test_weight_scan_500_lots() public {
        _fill(500);
        uint256 g = gasleft();
        lots.weight(W);
        console2.log("on-chain weight() over 500 lots", g - gasleft());
    }
}

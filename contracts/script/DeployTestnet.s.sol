// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {WarchestGovernance} from "../src/WarchestGovernance.sol";
import {WarchestVault} from "../src/WarchestVault.sol";
import {WarchestHook} from "../src/WarchestHook.sol";
import {IUniswapV3PoolMinimal} from "../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../src/interfaces/external/IWETH9.sol";
import {IAcrossSpokePool} from "../src/interfaces/external/IAcrossSpokePool.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {TestnetWETH, TestnetUSDG, TestnetOraclePool} from "../src/mocks/testnet/TestnetVenue.sol";
import {DeploySystem} from "./DeploySystem.s.sol";

/// @title DeployTestnet
/// @notice One command to deploy the WHOLE system on Robinhood Chain testnet (46630), including the testnet stand-ins
///         for what only exists on mainnet: WETH, USDG, the WETH/USDG oracle pool and the Across SpokePool (D6).
///         Uniswap v4 (PoolManager, PositionManager, Permit2) is the official deployment, same addresses as mainnet.
/// @dev Environment (all optional; each role defaults to the deployer so a single funded key is enough to start):
///      `GUARDIAN`, `UPDATER`, `KEEPER`, `HL_ACCOUNT`, `ETH_USD_TICK` [-197374 ≈ $2,690], `POOL_USDG_RESERVE`
///      [100,000,000 USDG], `LP_ETH_AMOUNT` [0.05 ether], `LP_TOKEN_AMOUNT` [half the supply].
///      Governance timings are shortened for testing (1 h challenge, 1 h vote); vault parameters match mainnet.
///      `forge script script/DeployTestnet.s.sol --rpc-url robinhood_testnet --account <keystore> --broadcast`
///      Writes the addresses to `deployments/46630.json`.
contract DeployTestnet is DeploySystem {
    uint256 public constant TESTNET_CHAIN_ID = 46630;

    struct Venue {
        TestnetWETH weth;
        TestnetUSDG usdg;
        TestnetOraclePool pool;
        MockAcrossSpokePool spokePool;
    }

    function run() external override returns (WarchestHook) {
        if (block.chainid != TESTNET_CHAIN_ID && block.chainid != 31337) {
            revert WrongChain(block.chainid, TESTNET_CHAIN_ID);
        }
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        (Venue memory v, System memory s) = deployTestnet(deployer);
        vm.stopBroadcast();
        _writeAddresses(v, s);
        return s.launch.hook;
    }

    function deployTestnet(address deployer) public returns (Venue memory v, System memory s) {
        v.weth = new TestnetWETH();
        v.usdg = new TestnetUSDG(deployer);
        v.pool = new TestnetOraclePool(
            address(v.weth), address(v.usdg), int24(vm.envOr("ETH_USD_TICK", int256(-197374))), deployer
        );
        v.usdg.mint(address(v.pool), vm.envOr("POOL_USDG_RESERVE", uint256(100_000_000e6)));
        v.spokePool = new MockAcrossSpokePool();

        SystemConfig memory sys = loadTestnetSystemConfig(v, deployer);
        s = deploySystem(sys, loadTestnetLaunchConfig(), deployer);

        // roles defaulting to the deployer: finish the two-step guardian handover right away
        if (sys.guardian == deployer) {
            s.governance.acceptGuardian();
            s.vault.acceptGuardian();
            s.distributor.acceptGuardian();
        }
    }

    function loadTestnetSystemConfig(Venue memory v, address deployer) public view returns (SystemConfig memory sys) {
        sys.guardian = vm.envOr("GUARDIAN", deployer);
        sys.updater = vm.envOr("UPDATER", deployer);
        sys.keeper = vm.envOr("KEEPER", deployer);
        sys.enableDistributor = true; // testnet exercises the full flow; the mainnet choice stays D7
        sys.gov = WarchestGovernance.Params({
            challengeWindow: 1 hours, votingPeriod: 1 hours, maxRootAge: 2 days, quorumBps: 1000
        });
        sys.eligibleAssets = new uint32[](3);
        (sys.eligibleAssets[0], sys.eligibleAssets[1], sys.eligibleAssets[2]) = (0, 1, 5); // BTC, ETH, SOL (HL)
        sys.venue = WarchestVault.Venue({
            pool: IUniswapV3PoolMinimal(address(v.pool)), weth: IWETH9(address(v.weth)), usdg: IERC20(address(v.usdg))
        });
        sys.bridge = WarchestVault.Bridge({
            spokePool: IAcrossSpokePool(address(v.spokePool)),
            recipient: vm.envOr("HL_ACCOUNT", deployer),
            outputToken: 0xb88339CB7199b77E23DB6E890353E22632Ba630f, // USDC on HyperEVM (informational on testnet)
            destinationChainId: 999
        });
        sys.conversion = WarchestVault.ConversionParams({
            twapWindow: 30 minutes, maxSlippageBps: 100, maxConvertPerCall: 50 ether, convertCooldown: 10 minutes
        });
        sys.orders = WarchestVault.OrderParams({
            capBps: 2_000,
            maxBridgeFeeBps: 50,
            maxDecisionAge: 3 days,
            stopLossBps: 500,
            leverage: 3,
            takeProfitBps: 1_000,
            reportChallengeWindow: 1 hours
        });
        sys.distributorTimelock = 1 hours;
    }

    function loadTestnetLaunchConfig() public view returns (Config memory cfg) {
        uint256 supply = vm.envOr("TOKEN_SUPPLY", uint256(1_000_000_000 ether));
        cfg = Config({
            poolManager: IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951),
            positionManager: IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7),
            permit2: IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3),
            vault: address(0), // set by deploySystem
            name: vm.envOr("TOKEN_NAME", string("Warchest")),
            symbol: vm.envOr("TOKEN_SYMBOL", string("WAR")),
            supply: supply,
            lpToken: vm.envOr("LP_TOKEN_AMOUNT", supply / 2),
            lpEth: vm.envOr("LP_ETH_AMOUNT", uint256(0.05 ether)),
            lpFee: 3000,
            tickSpacing: 60
        });
    }

    function _writeAddresses(Venue memory v, System memory s) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "token", address(s.launch.token));
        vm.serializeAddress(k, "hook", address(s.launch.hook));
        vm.serializeAddress(k, "governance", address(s.governance));
        vm.serializeAddress(k, "vault", address(s.vault));
        vm.serializeAddress(k, "distributor", address(s.distributor));
        vm.serializeAddress(k, "weth", address(v.weth));
        vm.serializeAddress(k, "usdg", address(v.usdg));
        vm.serializeAddress(k, "oraclePool", address(v.pool));
        string memory json = vm.serializeAddress(k, "spokePool", address(v.spokePool));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log(json);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {WarchestGovernance} from "../src/WarchestGovernance.sol";
import {WarchestVault} from "../src/WarchestVault.sol";
import {WarchestDistributor, IWarchestVaultDistribution} from "../src/WarchestDistributor.sol";
import {WarchestHook} from "../src/WarchestHook.sol";
import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {IUniswapV3PoolMinimal} from "../src/interfaces/external/IUniswapV3PoolMinimal.sol";
import {IWETH9} from "../src/interfaces/external/IWETH9.sol";
import {IAcrossSpokePool} from "../src/interfaces/external/IAcrossSpokePool.sol";
import {DeployWarchest} from "./DeployWarchest.s.sol";

/// @title DeploySystem
/// @notice Deploys and wires the whole on-chain system in the only valid order:
///         governance → (distributor) → vault → governance.setVault → (distributor.setVault) → eligible assets
///         → token + hook (fee recipient = vault) + pool + liquidity → guardian handover to the multisig.
/// @dev The broadcaster is the TEMPORARY guardian during wiring, then starts a two-step transfer to `GUARDIAN`
///      (the multisig must call `acceptGuardian()` on governance, vault and distributor). Until it does, the
///      deployer key holds every guardian power (pause, keeper rotation, report vetoes, delayed updater rotation,
///      cancelling its own handover) but can never move funds; keep the key offline and let no capital flow before
///      the multisig has accepted on all three contracts. Mainnet defaults: the script refuses any other chain.
///      Environment (defaults in brackets):
///      - `GUARDIAN` multisig, `UPDATER` indexer, `KEEPER` bot, `HL_ACCOUNT` Hyperliquid multisig account — required
///      - `ENABLE_DISTRIBUTOR` [false] — D7 (legal) decides; false = distribution permanently disabled
///      - `WARCHEST_VAULT` is NOT read: the hook's fee recipient is always the freshly deployed vault
///      - token/pool parameters: see {DeployWarchest.loadConfig}
contract DeploySystem is DeployWarchest {
    struct SystemConfig {
        address guardian;
        address updater;
        address keeper;
        bool enableDistributor;
        WarchestGovernance.Params gov;
        uint32[] eligibleAssets;
        WarchestVault.Venue venue;
        WarchestVault.Bridge bridge;
        WarchestVault.ConversionParams conversion;
        WarchestVault.OrderParams orders;
        uint64 distributorTimelock;
    }

    struct System {
        WarchestGovernance governance;
        WarchestVault vault;
        WarchestDistributor distributor;
        Deployment launch;
    }

    /// @notice The only chain the mainnet defaults (pool, WETH, USDG, SpokePool, USDC on HyperEVM) are valid for.
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    error WrongChain(uint256 chainId, uint256 expected);

    function run() external override returns (WarchestHook) {
        SystemConfig memory sys = loadSystemConfig();
        Config memory cfg = loadLaunchConfig();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        System memory s = deploySystem(sys, cfg, deployer);
        vm.stopBroadcast();

        console2.log("WarchestGovernance ", address(s.governance));
        console2.log("WarchestVault      ", address(s.vault));
        console2.log("WarchestDistributor", address(s.distributor));
        console2.log("WarchestToken      ", address(s.launch.token));
        console2.log("WarchestHook       ", address(s.launch.hook));
        console2.log("NEXT: the multisig must call acceptGuardian() on governance, vault and distributor");
        return s.launch.hook;
    }

    /// @notice Mainnet defaults (RESEARCH.md §1-§3); addresses of people/bots come from the environment.
    function loadSystemConfig() public view returns (SystemConfig memory sys) {
        sys.guardian = vm.envAddress("GUARDIAN");
        sys.updater = vm.envAddress("UPDATER");
        sys.keeper = vm.envAddress("KEEPER");
        sys.enableDistributor = vm.envOr("ENABLE_DISTRIBUTOR", false);
        sys = _defaults(sys, vm.envAddress("HL_ACCOUNT"));
    }

    function loadLaunchConfig() public view returns (Config memory cfg) {
        cfg = loadConfigWithVault(address(1)); // placeholder, replaced by the deployed vault
    }

    /// @notice Robinhood mainnet defaults for everything that is not a role address. Reverts on any other chain:
    ///         these addresses exist nowhere else, and a vault wired to them elsewhere would be bricked.
    function _defaults(SystemConfig memory sys, address hlAccount) internal view returns (SystemConfig memory) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid, ROBINHOOD_CHAIN_ID);
        sys.gov = WarchestGovernance.Params({
            challengeWindow: 6 hours, votingPeriod: 1 days, maxRootAge: 2 days, quorumBps: 1000
        });
        sys.eligibleAssets = new uint32[](3);
        (sys.eligibleAssets[0], sys.eligibleAssets[1], sys.eligibleAssets[2]) = (0, 1, 5); // BTC, ETH, SOL on HL
        sys.venue = WarchestVault.Venue({
            pool: IUniswapV3PoolMinimal(0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca),
            weth: IWETH9(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73),
            usdg: IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)
        });
        sys.bridge = WarchestVault.Bridge({
            spokePool: IAcrossSpokePool(0xD29C85F15DF544bA632C9E25829fd29d767d7978),
            recipient: hlAccount,
            outputToken: 0xb88339CB7199b77E23DB6E890353E22632Ba630f,
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
            reportChallengeWindow: 6 hours
        });
        sys.distributorTimelock = 1 days;
        return sys;
    }

    function defaultSystemConfig(address guardian, address updater, address keeper, address hlAccount, bool dist)
        public
        view
        returns (SystemConfig memory sys)
    {
        sys.guardian = guardian;
        sys.updater = updater;
        sys.keeper = keeper;
        sys.enableDistributor = dist;
        return _defaults(sys, hlAccount);
    }

    /// @notice Deploys and wires everything as `deployer` (temporary guardian), then hands over to `sys.guardian`.
    function deploySystem(SystemConfig memory sys, Config memory cfg, address deployer)
        public
        returns (System memory s)
    {
        s.governance = new WarchestGovernance(deployer, sys.updater, sys.gov);

        address distributorAddr;
        if (sys.enableDistributor) {
            s.distributor = new WarchestDistributor(sys.venue.usdg, deployer, sys.updater, sys.distributorTimelock);
            distributorAddr = address(s.distributor);
        }

        s.vault = new WarchestVault(
            deployer,
            sys.keeper,
            IWarchestDecisionSource(address(s.governance)),
            distributorAddr,
            sys.venue,
            sys.bridge,
            sys.conversion,
            sys.orders
        );

        s.governance.setVault(address(s.vault));
        s.governance.setEligibleAssets(sys.eligibleAssets);
        if (sys.enableDistributor) s.distributor.setVault(IWarchestVaultDistribution(address(s.vault)));

        cfg.vault = address(s.vault);
        s.launch = launch(cfg, deployer);

        s.governance.transferGuardian(sys.guardian);
        s.vault.transferGuardian(sys.guardian);
        if (sys.enableDistributor) s.distributor.transferGuardian(sys.guardian);
    }
}

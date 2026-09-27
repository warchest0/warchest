// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {WarchestHook} from "../src/WarchestHook.sol";
import {HookMiner} from "./utils/HookMiner.sol";

/// @title DeployWarchestHook
/// @notice Mines a CREATE2 salt and deploys `WarchestHook` through the deterministic CREATE2 deployer
///         (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, present on Robinhood Chain) so that the hook address encodes
///         the permission flags required by the PoolManager.
/// @dev Environment variables:
///      - `POOL_MANAGER`     Uniswap v4 PoolManager (mainnet 4663: 0x8366a39CC670B4001A1121B8F6A443A643e40951)
///      - `WARCHEST_TOKEN`   WarchestToken address
///      - `WARCHEST_VAULT`   immutable fee recipient
///      - `POOL_INITIALIZER` the only address allowed to call `PoolManager.initialize` for the ETH/WARCHEST pool
///
///      Example:
///      `forge script script/DeployWarchestHook.s.sol --rpc-url robinhood_testnet --broadcast --verify`
///
///      The initializer must later call `PoolManager.initialize(key, sqrtPriceX96)` DIRECTLY (not through the
///      PositionManager multicall, whose `sender` would be the PositionManager).
contract DeployWarchestHook is Script {
    /// @notice Arachnid's deterministic CREATE2 deployer proxy.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Flags encoded in the hook address; must match `WarchestHook.getHookPermissions()`.
    uint160 public constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    error Create2DeployerMissing();
    error Create2Failed();
    error UnexpectedAddress(address expected, address actual);
    error BadImmutables();

    function run() external returns (WarchestHook hook) {
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        address token = vm.envAddress("WARCHEST_TOKEN");
        address vault = vm.envAddress("WARCHEST_VAULT");
        address initializer = vm.envAddress("POOL_INITIALIZER");

        (address expected, bytes32 salt) = mine(poolManager, token, vault, initializer);
        console2.log("WarchestHook expected address:", expected);
        console2.log("salt:", vm.toString(salt));

        vm.startBroadcast();
        hook = deploy(salt, poolManager, token, vault, initializer);
        vm.stopBroadcast();

        console2.log("WarchestHook deployed at:", address(hook));
    }

    /// @notice Finds the salt producing a flag-compatible address for the given constructor arguments.
    function mine(IPoolManager poolManager, address token, address vault, address initializer)
        public
        view
        returns (address expected, bytes32 salt)
    {
        if (CREATE2_DEPLOYER.code.length == 0) revert Create2DeployerMissing();
        return HookMiner.find(
            CREATE2_DEPLOYER,
            HOOK_FLAGS,
            type(WarchestHook).creationCode,
            abi.encode(poolManager, token, vault, initializer)
        );
    }

    /// @notice Deploys the hook via the CREATE2 deployer and checks the address and immutables.
    function deploy(bytes32 salt, IPoolManager poolManager, address token, address vault, address initializer)
        public
        returns (WarchestHook hook)
    {
        // forge-lint: disable-next-item(encode-packed-collision)
        bytes memory initCode =
            abi.encodePacked(type(WarchestHook).creationCode, abi.encode(poolManager, token, vault, initializer));
        address expected = HookMiner.computeAddress(CREATE2_DEPLOYER, salt, keccak256(initCode));

        // The proxy expects `salt ++ initCode` as calldata and returns the 20-byte address of the new contract.
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        if (!ok || ret.length != 20) revert Create2Failed();
        // forge-lint: disable-next-line(unsafe-typecast)
        hook = WarchestHook(address(bytes20(ret))); // exactly 20 bytes, checked above

        if (address(hook) != expected) revert UnexpectedAddress(expected, address(hook));
        if (uint160(address(hook)) & Hooks.ALL_HOOK_MASK != HOOK_FLAGS) {
            revert UnexpectedAddress(expected, address(hook));
        }
        if (
            address(hook.poolManager()) != address(poolManager) || Currency.unwrap(hook.token()) != token
                || hook.vault() != vault || hook.initializer() != initializer
        ) revert BadImmutables();
    }
}

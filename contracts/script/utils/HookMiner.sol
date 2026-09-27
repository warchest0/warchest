// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @title HookMiner
/// @notice Minimal library for mining a CREATE2 salt such that the resulting hook address encodes the desired
///         permission flags in its 14 low bits.
/// @dev Adapted from Uniswap `v4-periphery/test/shared/HookMiner.sol` (MIT, Uniswap Labs). Differences: the init-code
///      hash is computed once instead of at every iteration, and a custom error replaces the string revert.
library HookMiner {
    /// @dev Mask selecting the 14 flag bits of an address.
    uint160 internal constant FLAG_MASK = Hooks.ALL_HOOK_MASK;

    /// @dev Upper bound on the salts tried. With 14 flag bits the expected number of tries is 2^14 = 16 384.
    uint256 internal constant MAX_LOOP = 1_000_000;

    error SaltNotFound();

    /// @notice Finds a salt that produces a hook address whose 14 low bits equal `flags`.
    /// @param deployer The address performing the CREATE2: the test contract in `forge test`, or the deterministic
    ///        CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` in a script.
    /// @param flags Desired flags, e.g. `Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG`.
    /// @param creationCode `type(Hook).creationCode`.
    /// @param constructorArgs `abi.encode(<constructor arguments>)`.
    /// @return hookAddress The address the hook deploys to with `salt`.
    /// @return salt The salt to use with `new Hook{salt: salt}(...)` or the CREATE2 deployer.
    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        flags &= FLAG_MASK;
        // Init code is by definition creationCode ++ constructorArgs: concatenation is the intent, not a hash key.
        // forge-lint: disable-next-line(encode-packed-collision)
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 s = 0; s < MAX_LOOP; ++s) {
            hookAddress = computeAddress(deployer, bytes32(s), initCodeHash);
            if (uint160(hookAddress) & FLAG_MASK == flags && hookAddress.code.length == 0) {
                return (hookAddress, bytes32(s));
            }
        }
        revert SaltNotFound();
    }

    /// @notice CREATE2 address for `deployer`, `salt` and the keccak256 of the init code (creation code + args).
    function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}

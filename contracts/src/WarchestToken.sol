// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WarchestToken
/// @notice Plain fixed-supply ERC20. By design it contains NO transfer tax and NO fee logic:
///         the 10% trading fee is collected exclusively by WarchestHook at swap time.
contract WarchestToken is ERC20 {
    error ZeroRecipient();

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param totalSupply_ Entire supply, minted once to `recipient` (no mint function exists afterwards).
    /// @param recipient Receiver of the full supply (e.g. the deployer multisig seeding liquidity).
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, address recipient)
        ERC20(name_, symbol_)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        _mint(recipient, totalSupply_);
    }
}

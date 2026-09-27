// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IWETH9
/// @notice Wrapped native ETH. On Robinhood Chain: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (upgradeable proxy,
///         standard `deposit`/`withdraw`, verified on a mainnet fork in `test/fork/WarchestVaultFork.t.sol`).
interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

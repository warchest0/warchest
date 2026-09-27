// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WarchestToken} from "../src/WarchestToken.sol";

contract WarchestTokenTest is Test {
    uint256 constant SUPPLY = 1_000_000_000 ether;
    address constant TREASURY = address(0xA11CE);
    WarchestToken token;

    function setUp() public {
        token = new WarchestToken("Warchest", "WAR", SUPPLY, TREASURY);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Warchest");
        assertEq(token.symbol(), "WAR");
        assertEq(token.decimals(), 18);
    }

    function test_fullSupplyMintedToRecipient() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(TREASURY), SUPPLY);
    }

    function test_revertsOnZeroRecipient() public {
        vm.expectRevert(WarchestToken.ZeroRecipient.selector);
        new WarchestToken("Warchest", "WAR", SUPPLY, address(0));
    }

    /// Non-negotiable constraint: a transfer moves exactly `amount`, no tax, no side effect on supply.
    function testFuzz_transferHasNoTax(address to, uint256 amount) public {
        vm.assume(to != address(0) && to != TREASURY);
        amount = bound(amount, 0, SUPPLY);
        vm.prank(TREASURY);
        token.transfer(to, amount);
        assertEq(token.balanceOf(to), amount);
        assertEq(token.balanceOf(TREASURY), SUPPLY - amount);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function testFuzz_transferFromHasNoTax(address spender, address to, uint256 amount) public {
        vm.assume(spender != address(0) && to != address(0) && to != TREASURY);
        amount = bound(amount, 0, SUPPLY);
        vm.prank(TREASURY);
        token.approve(spender, amount);
        vm.prank(spender);
        token.transferFrom(TREASURY, to, amount);
        assertEq(token.balanceOf(to), amount);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /// Supply is fixed forever: the contract exposes no mint/burn/owner surface.
    function test_noPrivilegedSurface() public view {
        bytes4[4] memory forbidden = [
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("owner()")),
            bytes4(keccak256("burn(uint256)")),
            bytes4(keccak256("setFee(uint256)"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(token).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok);
        }
    }
}

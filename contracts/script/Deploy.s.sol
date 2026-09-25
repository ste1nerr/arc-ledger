// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {PeriodCloseRegistry} from "../src/PeriodCloseRegistry.sol";

/// @notice Deploys PeriodCloseRegistry. The signer is supplied on the command line
///         (--account <keystore>, --interactive or --ledger); no key is read from env.
contract Deploy is Script {
    uint256 internal constant ARC_MAINNET = 5042;

    function run() external returns (PeriodCloseRegistry registry) {
        require(block.chainid == ARC_MAINNET, "not Arc mainnet (5042)");
        vm.startBroadcast();
        registry = new PeriodCloseRegistry();
        vm.stopBroadcast();
        console2.log("PeriodCloseRegistry deployed at", address(registry));
    }
}

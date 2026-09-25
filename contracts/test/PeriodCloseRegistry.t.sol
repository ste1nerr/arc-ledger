// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PeriodCloseRegistry} from "../src/PeriodCloseRegistry.sol";

contract PeriodCloseRegistryTest is Test {
    event PeriodClosed(
        address indexed account,
        bytes32 indexed reportHash,
        uint64 periodStart,
        uint64 periodEnd,
        uint32 rowCount,
        string uri
    );

    PeriodCloseRegistry internal registry;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant HASH_A = keccak256("report A");
    bytes32 internal constant HASH_B = keccak256("report B");
    uint64 internal constant SEP_START = 1788220800; // 2026-09-01T00:00:00Z
    uint64 internal constant SEP_END = 1790812800; // 2026-10-01T00:00:00Z

    function setUp() public {
        registry = new PeriodCloseRegistry();
        vm.warp(1790900000);
        vm.roll(22_800_000);
    }

    // ---------- happy path ----------

    function test_closePeriod_storesClose() public {
        vm.prank(alice);
        uint256 index = registry.closePeriod(HASH_A, SEP_START, SEP_END, 42, "ipfs://bafy");

        assertEq(index, 0);
        assertEq(registry.closeCount(alice), 1);
        PeriodCloseRegistry.Close[] memory closes = registry.closesOf(alice);
        assertEq(closes.length, 1);
        assertEq(closes[0].reportHash, HASH_A);
        assertEq(closes[0].periodStart, SEP_START);
        assertEq(closes[0].periodEnd, SEP_END);
        assertEq(closes[0].rowCount, 42);
        assertEq(closes[0].closedAt, 1790900000);
        assertEq(closes[0].blockNumber, 22_800_000);
        assertEq(closes[0].uri, "ipfs://bafy");
    }

    function test_closePeriod_emitsEventWithAllFields() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit PeriodClosed(alice, HASH_A, SEP_START, SEP_END, 7, "");
        vm.prank(alice);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 7, "");
    }

    function test_closePeriod_accountIsMsgSender() public {
        vm.prank(alice);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 1, "");
        assertEq(registry.closeCount(alice), 1);
        assertEq(registry.closeCount(bob), 0);
        assertEq(registry.closeCount(address(this)), 0);
    }

    function test_closePeriod_zeroRowsAndEmptyUriAllowed() public {
        vm.prank(alice);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 0, "");
        assertEq(registry.closesOf(alice)[0].rowCount, 0);
    }

    function test_sameHash_differentAccounts_isAllowed() public {
        vm.prank(alice);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 1, "");
        vm.prank(bob);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 1, "");
        assertEq(registry.closeCount(alice), 1);
        assertEq(registry.closeCount(bob), 1);
    }

    // ---------- reverts ----------

    function test_revert_zeroHash() public {
        vm.prank(alice);
        vm.expectRevert(PeriodCloseRegistry.ZeroReportHash.selector);
        registry.closePeriod(bytes32(0), SEP_START, SEP_END, 1, "");
    }

    function test_revert_periodEndEqualsStart() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PeriodCloseRegistry.InvalidPeriod.selector, SEP_START, SEP_START));
        registry.closePeriod(HASH_A, SEP_START, SEP_START, 1, "");
    }

    function test_revert_periodEndBeforeStart() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PeriodCloseRegistry.InvalidPeriod.selector, SEP_END, SEP_START));
        registry.closePeriod(HASH_A, SEP_END, SEP_START, 1, "");
    }

    function test_revert_duplicateHash_samePeriod() public {
        vm.startPrank(alice);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 1, "");
        vm.expectRevert(abi.encodeWithSelector(PeriodCloseRegistry.AlreadyClosed.selector, HASH_A, 0));
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 1, "");
        vm.stopPrank();
    }

    function test_revert_duplicateHash_evenWithOtherPeriodAndUri() public {
        vm.startPrank(alice);
        registry.closePeriod(HASH_B, SEP_START, SEP_END, 1, "");
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 1, "");
        vm.expectRevert(abi.encodeWithSelector(PeriodCloseRegistry.AlreadyClosed.selector, HASH_A, 1));
        registry.closePeriod(HASH_A, 1, 2, 99, "https://x");
        vm.stopPrank();
    }

    function test_revert_leavesStateUnchanged() public {
        vm.prank(alice);
        vm.expectRevert(PeriodCloseRegistry.ZeroReportHash.selector);
        registry.closePeriod(bytes32(0), SEP_START, SEP_END, 1, "");
        assertEq(registry.closeCount(alice), 0);
    }

    // ---------- amendments ----------

    function test_amendment_samePeriodNewHash_appendsHistory() public {
        vm.prank(alice);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 5, "");
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 170_000);
        vm.prank(alice);
        uint256 index = registry.closePeriod(HASH_B, SEP_START, SEP_END, 6, "ipfs://v2");

        assertEq(index, 1);
        PeriodCloseRegistry.Close[] memory closes = registry.closesOf(alice);
        assertEq(closes.length, 2);
        assertEq(closes[0].reportHash, HASH_A);
        assertEq(closes[1].reportHash, HASH_B);
        assertGt(closes[1].closedAt, closes[0].closedAt);

        (bool foundA, uint256 idxA,) = registry.findClose(alice, HASH_A);
        (bool foundB, uint256 idxB, PeriodCloseRegistry.Close memory b) = registry.findClose(alice, HASH_B);
        assertTrue(foundA && foundB);
        assertEq(idxA, 0);
        assertEq(idxB, 1);
        assertEq(b.rowCount, 6);
        assertEq(b.uri, "ipfs://v2");
    }

    // ---------- views ----------

    function test_findClose_unknown() public view {
        (bool found, uint256 index, PeriodCloseRegistry.Close memory c) = registry.findClose(alice, HASH_A);
        assertFalse(found);
        assertEq(index, 0);
        assertEq(c.reportHash, bytes32(0));
    }

    function test_findClose_otherAccountDoesNotMatch() public {
        vm.prank(alice);
        registry.closePeriod(HASH_A, SEP_START, SEP_END, 1, "");
        (bool found,,) = registry.findClose(bob, HASH_A);
        assertFalse(found);
    }

    function test_closesOfPaged() public {
        vm.startPrank(alice);
        for (uint256 i = 1; i <= 5; ++i) {
            registry.closePeriod(bytes32(i), uint64(i), uint64(i + 1), uint32(i), "");
        }
        vm.stopPrank();

        PeriodCloseRegistry.Close[] memory page = registry.closesOfPaged(alice, 1, 2);
        assertEq(page.length, 2);
        assertEq(page[0].reportHash, bytes32(uint256(2)));
        assertEq(page[1].reportHash, bytes32(uint256(3)));

        page = registry.closesOfPaged(alice, 4, 10);
        assertEq(page.length, 1);
        assertEq(page[0].reportHash, bytes32(uint256(5)));

        assertEq(registry.closesOfPaged(alice, 5, 10).length, 0);
        assertEq(registry.closesOfPaged(alice, 0, 0).length, 0);
        assertEq(registry.closesOfPaged(alice, 0, type(uint256).max).length, 5);
        assertEq(registry.closesOfPaged(alice, type(uint256).max, type(uint256).max).length, 0);
    }

    // ---------- fuzz ----------

    function testFuzz_periods(uint64 start, uint64 end, bytes32 hash, uint32 rows) public {
        vm.assume(hash != bytes32(0));
        vm.prank(alice);
        if (end <= start) {
            vm.expectRevert(abi.encodeWithSelector(PeriodCloseRegistry.InvalidPeriod.selector, start, end));
            registry.closePeriod(hash, start, end, rows, "");
            assertEq(registry.closeCount(alice), 0);
        } else {
            registry.closePeriod(hash, start, end, rows, "");
            PeriodCloseRegistry.Close[] memory closes = registry.closesOf(alice);
            assertEq(closes.length, 1);
            assertEq(closes[0].periodStart, start);
            assertEq(closes[0].periodEnd, end);
            assertEq(closes[0].rowCount, rows);
        }
    }

    function testFuzz_amendmentsKeepOrder(bytes32 seed, uint8 n) public {
        n = uint8(bound(n, 1, 20));
        vm.startPrank(alice);
        for (uint256 i = 0; i < n; ++i) {
            bytes32 h = keccak256(abi.encode(seed, i));
            assertEq(registry.closePeriod(h, SEP_START, SEP_END, uint32(i), ""), i);
        }
        vm.stopPrank();
        PeriodCloseRegistry.Close[] memory closes = registry.closesOf(alice);
        assertEq(closes.length, n);
        for (uint256 i = 0; i < n; ++i) {
            assertEq(closes[i].reportHash, keccak256(abi.encode(seed, i)));
            (bool found, uint256 index,) = registry.findClose(alice, closes[i].reportHash);
            assertTrue(found);
            assertEq(index, i);
        }
    }
}

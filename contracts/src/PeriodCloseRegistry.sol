// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title PeriodCloseRegistry
/// @notice Append-only registry where an account "closes" an accounting period by committing
///         the keccak256 hash of its canonical Arc Ledger report (see docs/REPORT_SPEC.md).
///         Anyone can later recompute the hash of a report file and check it against this registry.
/// @dev Holds no funds, has no owner, and is not upgradeable. An account can only write its own closes.
///      Re-closing the same period with a different hash records an amendment; the newest close
///      for a given (periodStart, periodEnd) is the one that counts. The full history stays readable.
contract PeriodCloseRegistry {
    struct Close {
        bytes32 reportHash;
        uint64 periodStart; // unix seconds, inclusive
        uint64 periodEnd; // unix seconds, exclusive
        uint32 rowCount;
        uint64 closedAt; // block.timestamp of the close
        uint64 blockNumber; // block of the close, to find the tx/event cheaply
        string uri; // optional location of the report file (ipfs:// or https://), may be empty
    }

    event PeriodClosed(
        address indexed account,
        bytes32 indexed reportHash,
        uint64 periodStart,
        uint64 periodEnd,
        uint32 rowCount,
        string uri
    );

    error InvalidPeriod(uint64 periodStart, uint64 periodEnd);
    error ZeroReportHash();
    error AlreadyClosed(bytes32 reportHash, uint256 index);

    mapping(address account => Close[]) private _closes;
    /// @dev index + 1 of a close by (account, reportHash); 0 means "not closed".
    mapping(address account => mapping(bytes32 reportHash => uint256 indexPlusOne)) private _indexOf;

    /// @notice Close a period for msg.sender by committing the report hash.
    /// @return index Position of the new close in `closesOf(msg.sender)`.
    function closePeriod(bytes32 reportHash, uint64 periodStart, uint64 periodEnd, uint32 rowCount, string calldata uri)
        external
        returns (uint256 index)
    {
        if (reportHash == bytes32(0)) revert ZeroReportHash();
        if (periodEnd <= periodStart) revert InvalidPeriod(periodStart, periodEnd);
        uint256 existing = _indexOf[msg.sender][reportHash];
        if (existing != 0) revert AlreadyClosed(reportHash, existing - 1);

        Close[] storage closes = _closes[msg.sender];
        index = closes.length;
        closes.push(
            Close({
                reportHash: reportHash,
                periodStart: periodStart,
                periodEnd: periodEnd,
                rowCount: rowCount,
                // casting to uint64 is safe: timestamps and block numbers stay far below 2^64
                // forge-lint: disable-next-line(unsafe-typecast)
                closedAt: uint64(block.timestamp),
                // forge-lint: disable-next-line(unsafe-typecast)
                blockNumber: uint64(block.number),
                uri: uri
            })
        );
        _indexOf[msg.sender][reportHash] = index + 1;

        emit PeriodClosed(msg.sender, reportHash, periodStart, periodEnd, rowCount, uri);
    }

    /// @notice Number of closes recorded for `account`.
    function closeCount(address account) external view returns (uint256) {
        return _closes[account].length;
    }

    /// @notice All closes of `account`, oldest first.
    function closesOf(address account) external view returns (Close[] memory) {
        return _closes[account];
    }

    /// @notice A page of closes of `account`, oldest first. Returns fewer than `limit` items at the end.
    function closesOfPaged(address account, uint256 offset, uint256 limit) external view returns (Close[] memory page) {
        Close[] storage closes = _closes[account];
        uint256 len = closes.length;
        if (offset >= len) return new Close[](0);
        uint256 end = len - offset < limit ? len : offset + limit;
        page = new Close[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = closes[i];
        }
    }

    /// @notice Look up a close by its report hash.
    function findClose(address account, bytes32 reportHash)
        external
        view
        returns (bool found, uint256 index, Close memory close)
    {
        uint256 indexPlusOne = _indexOf[account][reportHash];
        found = indexPlusOne != 0;
        if (found) {
            index = indexPlusOne - 1;
            close = _closes[account][index];
        }
    }
}

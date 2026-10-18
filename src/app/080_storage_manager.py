class StorageManager(_StorageManagerInit, _StorageManagerReads, _StorageManagerFiles, _StorageManagerNotesThumbnails, _StorageManagerReplication, _StorageManagerReplicationCycle, _StorageManagerScrub, _StorageManagerNodes, _StorageManagerNodeAdmin):
    """Unified storage manager that routes operations to the appropriate backend.
    In single-node mode (local only), this is a thin wrapper around disk I/O.
    In multi-node mode, handles read routing (primary with fallback),
    write routing (local preferred), and replication tracking."""

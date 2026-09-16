/**
 * Injection token for the backup destination.
 *
 * An interface cannot be a Nest provider token, and the whole point of the
 * BackupDestination seam is that the concrete class is swappable: Q34 decides
 * where backups actually go, and when it does, that is one line in
 * BackupModule with no consumer changing.
 *
 * Same pattern as EMBEDDING_PROVIDER in the data-cleaning module.
 */
export const BACKUP_DESTINATION = Symbol('BACKUP_DESTINATION');

import type { PermissionAction, PermissionModule } from '../../rbac/role-matrix';

export interface PermissionGrant {
  id: string;
  granteeId: string;
  granteeName: string | null;
  module: PermissionModule;
  action: PermissionAction;
  reason: string;
  grantedBy: string;
  grantedByName: string | null;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedByName: string | null;
  // Derived, not stored — true when granted, not revoked, and not past
  // expiresAt (if any). What PermissionGuard actually checks against.
  isActive: boolean;
}

export interface CreatePermissionGrantPayload {
  granteeId: string;
  module: PermissionModule;
  action: PermissionAction;
  reason: string;
  expiresAt?: string;
}

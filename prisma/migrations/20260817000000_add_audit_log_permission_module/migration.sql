-- RIO-NFR-004 / RIO-FR-007 module-conflict fix: archiveSharingAudit was
-- shared between the Audit Log (audit.controller.ts) and Study/Report Sharing
-- (sharing.controller.ts, report-sharing.controller.ts). NGO Admin held
-- read/create/approve on archiveSharingAudit for Sharing, which also gave it
-- unintended read access to the raw Audit Log. This new module isolates the
-- Audit Log behind its own permission bit so those two concerns can be granted
-- independently. Granted to system_admin and center_supervisor only.
ALTER TYPE "PermissionModule" ADD VALUE IF NOT EXISTS 'auditLog';

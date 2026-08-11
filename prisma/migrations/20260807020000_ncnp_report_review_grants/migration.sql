-- RESTORED 2026-08-07. The original migration.sql for this directory was
-- lost locally (empty directory + a row in _prisma_migrations saying it had
-- been applied, which blocked every `prisma migrate` command with P3015).
-- Reconstructed from the live database's actual privileges on
-- ncnp_report_reviews (information_schema.role_table_grants); it reproduces
-- the applied state exactly.
--
-- Follow-up to 20260730112558_add_ncnp_report_review, which created the
-- table but never granted the runtime roles anything on it. Every other
-- table gets its grants in the same migration that creates it; this one was
-- missed, so the NCNP review workflow failed at runtime with "permission
-- denied for table ncnp_report_reviews" until these were added.
--
-- ncnp_report_reviews is deliberately a global table with no org_id and no
-- RLS (the NCNP Compiled Report is kingdom-wide, not org-scoped), so there
-- are no policies to add here — only privileges. The app writes it through
-- runAsSupervisorWrite, which is safe precisely because there is no RLS
-- policy on this table to bypass.

GRANT SELECT, INSERT, UPDATE, DELETE ON "ncnp_report_reviews" TO cnap_app;
GRANT SELECT ON "ncnp_report_reviews" TO cnap_supervisor;

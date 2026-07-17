-- studies/needs/evidence/ai_decisions (added in 20260714120000_week2_data_capture,
-- an earlier/separate pass) got a cnap_supervisor RLS *policy*
-- (studies_supervisor_read etc.) but never the matching plain GRANT SELECT —
-- an RLS policy alone doesn't grant table access; Postgres checks both.
-- This was latent until the Sharing module's cross-org study lookup
-- (SharingService.create, via TenantPrismaService.runAsSupervisor) actually
-- exercised it and surfaced "permission denied for table studies". Kept as
-- its own migration (rather than folded into the schema migration above)
-- since it's a grants-only fix for tables from an earlier, unrelated pass.
GRANT SELECT ON "studies", "needs", "evidence", "ai_decisions" TO cnap_supervisor;

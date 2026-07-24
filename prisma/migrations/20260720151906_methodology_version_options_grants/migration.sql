-- The app connects as `cnap_app` (see APP_DATABASE_URL / PrismaService),
-- not the migration-running `cnap_owner` role — a newly created table isn't
-- readable by the app until explicitly granted, same pattern every other
-- table in this schema already follows (see e.g. the `methodology_configs`
-- grant in 20260716093000_dev1_week2_week3_schema/migration.sql).
GRANT SELECT ON "methodology_version_options" TO cnap_app;
GRANT SELECT ON "methodology_version_options" TO cnap_supervisor;
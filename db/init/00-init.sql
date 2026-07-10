-- Owner role: used by the Prisma CLI (migrate/seed). NOT a superuser, so FORCE RLS still applies.
CREATE ROLE cnap_owner WITH LOGIN PASSWORD 'cnap_owner_dev_pw' CREATEROLE CREATEDB;

-- Application runtime role: NOBYPASSRLS (default for new roles; stated explicitly).
CREATE ROLE cnap_app WITH LOGIN PASSWORD 'cnap_app_dev_pw' NOBYPASSRLS;

CREATE DATABASE cnap OWNER cnap_owner;

\connect cnap
-- cnap_app may use the schema; table-level grants are issued by the RLS migration (Task 4).
GRANT USAGE ON SCHEMA public TO cnap_app;

-- Encryption at rest readiness (RIO-NFR-001). pgcrypto provides column-level
-- crypto (pgp_sym_encrypt/decrypt, digest, gen_random_bytes) for any future
-- ultra-sensitive fields. Bulk at-rest protection is provided by encrypted
-- storage volumes at the deployment layer; this extension covers the
-- application-controlled column-encryption case. pgcrypto is a trusted
-- extension (PG13+), installable by the schema owner.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

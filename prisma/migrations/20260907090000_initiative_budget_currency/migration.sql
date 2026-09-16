-- Client feedback 2026-09-07 — Initiative budget needs an explicit
-- currency (funding isn't always SAR). Defaults to SAR for existing rows.
ALTER TABLE "initiatives" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'SAR';

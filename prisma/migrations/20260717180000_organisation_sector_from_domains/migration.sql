-- Organisation.sector stops being a fixed Postgres enum (education/
-- healthcare/agriculture/wash/livelihoods/disaster_relief/other) and
-- becomes a plain string holding a Domain's `name` from the Methodology
-- Configuration screen (e.g. "Health", "Water & Sanitation") instead —
-- "other" remains a valid value (paired with `purpose` for free text), it's
-- just no longer a Postgres-enforced enum member. Existing values already
-- match this shape 1:1, so this is a lossless type widen.
ALTER TABLE "organisations" ALTER COLUMN "sector" TYPE VARCHAR(200) USING "sector"::text;
DROP TYPE "Sector";

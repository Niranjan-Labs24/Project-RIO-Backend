-- RIO-FR-008 — the Geographic Dashboard needs a point per place before it can
-- draw anything, and the KSA Geographic Reference workbook ships none.
--
-- Coordinates go on BOTH levels now, on purpose. Governorate coordinates are
-- derivable today from geoBoundaries ADM2; center coordinates are not
-- published anywhere (geoBoundaries has no ADM3 for Saudi Arabia, and
-- geocoding the English transliterations misses ~75% of them), so they are
-- waiting on the client. Adding both columns in one migration means the
-- switch to center level, whenever that data arrives, is a seed run rather
-- than another schema change and another release.
--
-- Nullable throughout: a place with no coordinate is a place the map simply
-- does not plot. That is the correct behaviour — a governorate drawn in the
-- wrong spot is worse than one left off, because funding priority gets read
-- off this map.

ALTER TABLE "governorates"
  ADD COLUMN "latitude"  DECIMAL(9,6),
  ADD COLUMN "longitude" DECIMAL(9,6);

ALTER TABLE "centers"
  ADD COLUMN "latitude"  DECIMAL(9,6),
  ADD COLUMN "longitude" DECIMAL(9,6);

-- The dashboard's own query is "every place that can be plotted", so both
-- partial indexes cover exactly the rows it reads and skip the rest.
CREATE INDEX "governorates_plottable_idx" ON "governorates"("id")
  WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;
CREATE INDEX "centers_plottable_idx" ON "centers"("id")
  WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;

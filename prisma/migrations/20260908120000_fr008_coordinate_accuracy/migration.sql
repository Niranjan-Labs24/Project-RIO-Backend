-- RIO-FR-008 — record how good each coordinate actually is.
--
-- The first migration stored only latitude/longitude, which threw away the
-- one fact that matters when half the data is estimated: 1,022 of our 1,404
-- centers were geocoded from their real name, but 365 fall back to their
-- governorate's centre and can be up to 166km out.
--
-- Without this, an approximate point renders identically to an exact one,
-- and somebody reads funding priority off a village that is 100km from
-- where the need actually is. Storing the accuracy is what lets the map
-- draw the two differently and say so.

ALTER TABLE "governorates"
  -- Metres. How far the true location might be from the stored point.
  ADD COLUMN "coordinate_accuracy_m" INTEGER,
  -- 'nominatim' | 'overpass' | 'governorate-fallback' — kept so a later
  -- re-run can tell which points are worth trying to improve.
  ADD COLUMN "coordinate_source" VARCHAR(40);

ALTER TABLE "centers"
  ADD COLUMN "coordinate_accuracy_m" INTEGER,
  ADD COLUMN "coordinate_source" VARCHAR(40);

-- RIO-FR-024: Sample Size Calculator (Cochran's formula + finite population
-- correction + MDE), computed and stored at study creation.
ALTER TABLE "studies" ADD COLUMN "population" INTEGER;
ALTER TABLE "studies" ADD COLUMN "margin_of_error" DOUBLE PRECISION DEFAULT 0.10;
ALTER TABLE "studies" ADD COLUMN "required_sample_size" INTEGER;
ALTER TABLE "studies" ADD COLUMN "minimum_detectable_effect" DOUBLE PRECISION;

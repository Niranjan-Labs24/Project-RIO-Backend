-- RIO-FR-011 (client-confirmed): once PUBLISHED with responses collected, a
-- survey is never edited in place — a new version is created instead. This
-- row (and every response already attached to it) never changes; a new
-- draft version points back to it via previous_version_id.
ALTER TABLE "surveys" ADD COLUMN "previous_version_id" UUID,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "surveys_previous_version_id_key" ON "surveys"("previous_version_id");

ALTER TABLE "surveys" ADD CONSTRAINT "surveys_previous_version_id_fkey" FOREIGN KEY ("previous_version_id") REFERENCES "surveys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

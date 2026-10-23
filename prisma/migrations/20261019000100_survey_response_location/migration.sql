-- Public-survey location field (client, 19 Oct 2026): the respondent picks
-- their area from the study's geography at registration; "Outside these
-- areas" is kept as an excluded response with no answers.
ALTER TABLE "survey_responses" ADD COLUMN "location_label" VARCHAR(200);
ALTER TABLE "survey_responses" ADD COLUMN "exclusion_reason" VARCHAR(64);

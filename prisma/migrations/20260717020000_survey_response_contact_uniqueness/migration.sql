-- Enforce the citizen flow's one-response-per-contact rule at the database
-- boundary so concurrent requests cannot bypass the service pre-check.
CREATE UNIQUE INDEX "survey_responses_study_id_contact_key"
ON "survey_responses"("study_id", "contact");

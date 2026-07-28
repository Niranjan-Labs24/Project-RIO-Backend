-- Enforce the citizen flow's one-response-per-contact rule at the database
-- boundary so concurrent requests cannot bypass the service pre-check.
-- Scoped to need_id, not study_id — each Need runs its own independent
-- survey, so the same contact may legitimately respond once per Need under
-- the same Study (see CitizenService.checkDuplicate/submitResponse).
CREATE UNIQUE INDEX "survey_responses_need_id_contact_key"
ON "survey_responses"("need_id", "contact");

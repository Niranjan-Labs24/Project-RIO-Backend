-- Dual-channel citizen verification: both citizen_otp_challenges and
-- survey_responses gain a `mobile` column alongside the existing `contact`
-- (email) column. Nullable at the DB level (not backfilled) so existing
-- rows created before this feature don't need a placeholder value — the
-- request contract (RequestOtpBody) requires both fields for every new
-- challenge going forward, so every row from this point on will have one.
ALTER TABLE "citizen_otp_challenges" ADD COLUMN "mobile" VARCHAR(32);
ALTER TABLE "survey_responses" ADD COLUMN "mobile" VARCHAR(32);

-- Either channel alone is enough to identify a duplicate respondent for a
-- given Need — see SurveyResponse.mobile's comment. Postgres treats
-- multiple NULLs as distinct under a unique index, so pre-existing rows
-- with mobile = NULL don't collide with each other or with new rows.
CREATE UNIQUE INDEX "survey_responses_need_id_mobile_key" ON "survey_responses"("need_id", "mobile");

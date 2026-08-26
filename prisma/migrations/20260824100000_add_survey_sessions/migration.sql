-- Survey abandonment tracking (client answer, 24 Aug — RPT10 Q-2).
--
-- Session/event level only: no answer value is stored by either table here.
-- `answered_count` is a count, `position` is an index into the question set;
-- neither carries what was answered. A submitted response remains the only
-- record of respondent data — see the SurveySession model comment.

CREATE TYPE "SurveySessionStatus" AS ENUM ('STARTED', 'IN_PROGRESS', 'VERIFIED', 'SUBMITTED', 'ABANDONED');
CREATE TYPE "SurveySessionStep" AS ENUM ('OPENED', 'DETAILS', 'OTP_REQUESTED', 'OTP_VERIFIED', 'ANSWERING', 'REVIEW', 'SUBMITTED');

CREATE TABLE "survey_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "need_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "survey_link_id" UUID NOT NULL,
    "survey_id" UUID,
    "status" "SurveySessionStatus" NOT NULL DEFAULT 'STARTED',
    "furthest_step" "SurveySessionStep" NOT NULL DEFAULT 'OPENED',
    "question_count" INTEGER NOT NULL DEFAULT 0,
    "answered_count" INTEGER NOT NULL DEFAULT 0,
    "contact" VARCHAR(320),
    "mobile" VARCHAR(32),
    "otp_challenge_id" UUID,
    "survey_response_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_event_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "abandoned_at" TIMESTAMPTZ(6),
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" TIMESTAMPTZ(6),

    CONSTRAINT "survey_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "survey_sessions_survey_response_id_key" ON "survey_sessions"("survey_response_id");
CREATE INDEX "survey_sessions_org_id_idx" ON "survey_sessions"("org_id");
CREATE INDEX "survey_sessions_study_id_idx" ON "survey_sessions"("study_id");
CREATE INDEX "survey_sessions_survey_id_idx" ON "survey_sessions"("survey_id");
CREATE INDEX "survey_sessions_survey_link_id_idx" ON "survey_sessions"("survey_link_id");
-- The sweep's and RPT10's shared access path: unfinished sessions by staleness.
CREATE INDEX "survey_sessions_status_last_event_at_idx" ON "survey_sessions"("status", "last_event_at");

CREATE TABLE "survey_session_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "step" "SurveySessionStep" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_session_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "survey_session_events_org_id_idx" ON "survey_session_events"("org_id");
CREATE INDEX "survey_session_events_session_id_idx" ON "survey_session_events"("session_id");

ALTER TABLE "survey_sessions" ADD CONSTRAINT "survey_sessions_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "survey_sessions" ADD CONSTRAINT "survey_sessions_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "survey_sessions" ADD CONSTRAINT "survey_sessions_need_id_fkey"
  FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "survey_sessions" ADD CONSTRAINT "survey_sessions_survey_link_id_fkey"
  FOREIGN KEY ("survey_link_id") REFERENCES "public_survey_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull, not Cascade: superseding a survey version must not delete the
-- abandonment history collected against it (see Survey.previousVersionId).
ALTER TABLE "survey_sessions" ADD CONSTRAINT "survey_sessions_survey_id_fkey"
  FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "survey_sessions" ADD CONSTRAINT "survey_sessions_survey_response_id_fkey"
  FOREIGN KEY ("survey_response_id") REFERENCES "survey_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "survey_session_events" ADD CONSTRAINT "survey_session_events_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "survey_session_events" ADD CONSTRAINT "survey_session_events_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "survey_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RIO-NFR-003 pattern) — same fail-closed NULLIF policy as
-- public_survey_links / citizen_otp_challenges / survey_responses, which the
-- citizen flow writes the same unauthenticated way (runAsOrg supplies the
-- org explicitly; there is no ambient session).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['survey_sessions','survey_session_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid);',
      t || '_org_isolation', t);
  END LOOP;
END $$;

-- Runtime grants for cnap_app (NOBYPASSRLS). DELETE is deliberately not
-- granted: an abandonment record is evidence about data collection, and the
-- application has no reason to erase one.
GRANT SELECT, INSERT, UPDATE ON "survey_sessions", "survey_session_events" TO cnap_app;

-- Cross-org read-only supervisor policies, matching the citizen tables.
CREATE POLICY survey_sessions_supervisor_read ON "survey_sessions" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY survey_session_events_supervisor_read ON "survey_session_events" FOR SELECT TO cnap_supervisor USING (true);
GRANT SELECT ON "survey_sessions", "survey_session_events" TO cnap_supervisor;

#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# psql (unlike the tsx scripts) doesn't load .env on its own. Pull out just
# DATABASE_URL rather than `source .env` — other values in there (e.g.
# SMTP_PASS) can contain spaces/characters that aren't valid shell syntax.
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
export DATABASE_URL

echo "1/12 Installing dependencies..."
pnpm install

echo "2/12 Resetting database..."
pnpm exec prisma migrate reset --force

echo "3/12 Regenerating Prisma client..."
pnpm run prisma:generate

# feat/report-types (Karthika's branch, merged here): new tables
# (ai_priority_summaries) and RPT14/village-report support landed via real
# migrations, so `migrate reset` above already applies them — no separate
# migrate step needed. But table GRANTs + the ai_priority_summaries RLS
# policy live in this standalone script, not in a migration file, so a fresh
# reset always wipes them and they must be reapplied here every time, or the
# app hits "permission denied for table ai_priority_summaries" at runtime
# (same class of bug as the study_governorates grant gap from earlier).
echo "4/12 Applying grants + RLS policy for tables outside migrations..."
pnpm run grant:access

echo "5/12 Seeding base data..."
pnpm run prisma:seed

# import:scoring-lookups looks up each CSV row's Question by questionId
# *before* it creates the MethodologyVersion row, so questions must be
# imported first — otherwise every lookup row is skipped (Question not
# found) and the MethodologyVersion (nested inside that same per-row loop)
# never gets created either, which then breaks import:domain-priority-config
# and seed:scored, which both require a PUBLISHED MethodologyVersion.
echo "6/12 Importing extended Question Bank..."
pnpm run import:questions

echo "7/12 Deactivating legacy duplicate questions..."
psql "$DATABASE_URL" -c "UPDATE \"questions\" SET \"used_in_mvp\" = false WHERE \"question_id\" !~ '^(CU|ED|EN|GV|H|IN|LV|SD|WS)[0-9]+\$' AND (\"domain\", \"sub_domain\") IN (SELECT \"domain\", \"sub_domain\" FROM \"questions\" WHERE \"question_id\" ~ '^(CU|ED|EN|GV|H|IN|LV|SD|WS)[0-9]+\$');"

echo "8/12 Importing scoring lookups..."
pnpm run import:scoring-lookups

echo "9/12 Importing domain priority weights..."
pnpm run import:domain-priority-config

# Region -> Governorate -> Center reference data (KSA_Geographic_Reference_EN.xlsx).
# `prisma migrate reset` wipes this table set along with everything else, and
# nothing above repopulates it — without this step, org signup, Study
# creation, and Need creation all have empty Governorate/Center pickers on a
# fresh setup (confirmed missing during this session's UAT pass).
echo "10/12 Importing geography reference data (Region/Governorate/Center)..."
pnpm run import:geography

# feat/report-types: seeds ONE fully-scored study (Study -> Need -> Survey ->
# responses -> ScoreRollups -> VillagePriorityAssessment -> Evidence) so the
# real report pipeline (buildReportDataSnapshot) has real data to render
# instead of silently falling back to the mock provider — needed to actually
# exercise report generation end to end (and therefore Report Sharing) after
# this merge. Idempotent — safe to re-run, skips if the study already exists.
echo "11/12 Seeding one fully-scored study for real report generation..."
pnpm run seed:scored

echo "12/12 Done. Starting app..."
pnpm run dev
 
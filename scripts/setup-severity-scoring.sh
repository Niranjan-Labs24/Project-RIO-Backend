#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# psql (unlike the tsx scripts) doesn't load .env on its own. Pull out just
# DATABASE_URL rather than `source .env` — other values in there (e.g.
# SMTP_PASS) can contain spaces/characters that aren't valid shell syntax.
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
export DATABASE_URL

echo "1/9 Installing dependencies..."
npm install

echo "2/9 Resetting database..."
npx prisma migrate reset --force

echo "3/9 Regenerating Prisma client..."
npm run prisma:generate

echo "4/9 Seeding base data..."
npm run prisma:seed

echo "5/9 Importing extended Question Bank..."
npx tsx prisma/import-questions.ts

echo "6/10 Deactivating legacy duplicate questions..."
psql "$DATABASE_URL" -c "UPDATE \"questions\" SET \"used_in_mvp\" = false WHERE \"question_id\" !~ '^(CU|ED|EN|GV|H|IN|LV|SD|WS)[0-9]+\$' AND (\"domain\", \"sub_domain\") IN (SELECT \"domain\", \"sub_domain\" FROM \"questions\" WHERE \"question_id\" ~ '^(CU|ED|EN|GV|H|IN|LV|SD|WS)[0-9]+\$');"

echo "7/10 Importing scoring lookups..."
npx tsx prisma/import-scoring-lookups.ts

echo "8/10 Importing domain priority weights..."
npx tsx prisma/import-domain-priority-config.ts

# Region -> Governorate -> Center reference data (KSA_Geographic_Reference_EN.xlsx).
# `prisma migrate reset` wipes this table set along with everything else, and
# nothing above repopulates it — without this step, org signup, Study
# creation, and Need creation all have empty Governorate/Center pickers on a
# fresh setup (confirmed missing during this session's UAT pass).
echo "9/10 Importing geography reference data (Region/Governorate/Center)..."
npx tsx prisma/import-geography.ts

echo "10/10 Done. Starting app..."
npm run dev
 
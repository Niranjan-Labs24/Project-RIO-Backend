-- RIO-FR-012/RIO-AI-002 (Round 5, client-confirmed 2026-08-24): the Round 4
-- answer that introduced Question.target_sector as a ranking signal was
-- itself corrected — question relevance comes entirely from Domain/
-- Sub-domain (AI-001's classification), not Target Sector. Target Sector
-- classifies the Study, not individual questions. Dropping the column added
-- in 20260824000000_question_target_sector_and_affected_population; that
-- migration's Need.affected_people/affected_households additions are
-- unaffected and remain in place.
ALTER TABLE "questions" DROP COLUMN "target_sector";

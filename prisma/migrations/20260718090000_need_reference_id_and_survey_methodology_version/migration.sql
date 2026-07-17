-- Need.referenceId: the submitter's own external tracking id (field form
-- number, partner org case id, etc.) — free text, optional.
ALTER TABLE "needs" ADD COLUMN "reference_id" VARCHAR(200);

-- Survey.methodologyVersion: a snapshot (never a live reference) of
-- MethodologyConfig.version at the moment a Survey was published, so a
-- later Methodology/Question Bank change can't retroactively change what an
-- already-published Survey claims it was built against.
ALTER TABLE "surveys" ADD COLUMN "methodology_version" VARCHAR(100);

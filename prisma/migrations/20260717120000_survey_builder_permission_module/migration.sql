-- Survey Builder is its own independent methodology feature (Question
-- Bank + AI-assisted questionnaire design), not a Study feature — gets its
-- own permission module rather than reusing studySurvey. Publish
-- Survey/QR and the Citizen public flow are unrelated and keep using their
-- existing modules unchanged.
ALTER TYPE "PermissionModule" ADD VALUE 'surveyBuilder';

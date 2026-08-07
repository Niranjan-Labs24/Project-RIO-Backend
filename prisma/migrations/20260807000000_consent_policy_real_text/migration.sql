-- RIO-DATA-001 — replace the placeholder consent copy with the real Terms of
-- Use and Data Sharing Policy.
--
-- Deliberately an in-place UPDATE of v1 rather than a new v2:
--
--   * The placeholder was never a policy anyone meaningfully agreed to — it
--     said so in its own text. Publishing the real copy as v2 would invalidate
--     every existing acceptance and re-prompt every NGO Admin at next login
--     (ConsentGuard compares the accepted version against the active one), for
--     wording that is the first real wording there has ever been.
--   * Acceptance records are unaffected: ConsentAcceptance.policyText snapshots
--     the text at acceptance time, so anyone who accepted the placeholder still
--     has exactly what they saw on record — this does not rewrite history.
--
-- If the intent later changes to "everyone must re-accept", that is a new row
-- (kind, 'v2', active = true) plus deactivating v1 — not an edit to this one.
--
-- Scoped with `WHERE text LIKE 'Buyer-supplied%'` so this is a one-shot
-- backfill of the seeded placeholder: an environment whose copy has already
-- been curated by hand is left alone, and re-running is a no-op.

UPDATE "consent_policies"
SET "text" = 'Terms of Use

Welcome to this RIO application. By accessing or using this platform, you agree to the following terms:

This application is provided solely for demonstration, testing, and evaluation purposes.
Any information entered into the application should be fictitious or non-sensitive unless explicitly authorized.
Users are responsible for ensuring that any content they submit complies with applicable laws and organizational policies.
Unauthorized access, misuse, or attempts to disrupt the application are prohibited.
The application owner may modify, suspend, or discontinue any feature without prior notice.
Features, workflows, and reports displayed in this demo may not represent the final production version.
Continued use of the application indicates your acceptance of these terms.'
WHERE "kind" = 'use_policy'
  AND "version" = 'v1'
  AND "text" LIKE 'Buyer-supplied%';

UPDATE "consent_policies"
SET "text" = 'Data Sharing Policy

We value your privacy and are committed to handling your information responsibly.

Information entered into this Rio application is used only for demonstration, testing, and evaluation purposes.
We do not sell or share your information with third parties for marketing purposes.
Data may be accessed by authorized administrators or support personnel solely to maintain and improve the application.
Aggregated and anonymized information may be used to evaluate system performance and enhance user experience.
Users should avoid entering confidential, personal, financial, or regulated information into this demonstration environment.
Appropriate security measures are implemented to help protect data; however, no electronic system can guarantee absolute security.
By using this application, you acknowledge and consent to the collection and processing of information as described in this policy.'
WHERE "kind" = 'data_sharing'
  AND "version" = 'v1'
  AND "text" LIKE 'Buyer-supplied%';

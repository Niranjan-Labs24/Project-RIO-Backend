-- GEN-10: the Arabic term for System Admin is "مدير النظام" everywhere.
-- Only the unpublished bootstrap placeholder carries the old wording; policies
-- written and published by an admin are never touched.
UPDATE consent_policies
SET text_ar = REPLACE(text_ar, 'مسؤول النظام', 'مدير النظام'),
    updated_at = NOW()
WHERE version = 'v0-placeholder'
  AND published_by IS NULL
  AND text_ar LIKE '%مسؤول النظام%';

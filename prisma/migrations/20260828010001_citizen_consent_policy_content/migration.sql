-- 2. The citizen consent notice as it stands today, lifted verbatim out of
-- the frontend's message catalogues (its five labelled sections flattened into
-- one body) and filed as v1.0 — the same version string the hard-coded
-- CONSENT_COPY_VERSION constant displayed, so a respondent who reads "Version
-- 1.0" before and after this deploy is reading the same notice.
--
-- Published and active, but with no published_by/reviewed_by: nobody approved
-- it, because no approval gate existed when it was written. The Consent
-- Policies tab shows those as "-", which is both the honest record and a
-- visible prompt to publish a reviewed successor.
--
-- Guarded by NOT EXISTS so re-running against a database that already has a
-- citizen policy (or one published through the UI) changes nothing.
INSERT INTO "consent_policies" ("id", "kind", "version", "text", "text_ar", "status", "active", "created_at", "updated_at", "published_at")
SELECT uuidv7(), 'citizen_consent'::"ConsentPolicyKind", '1.0', 'Personal Information Consent

Purpose: Your responses will be used to assess development needs in your village and to help plan community programs. Participation is entirely voluntary, and you may stop at any time.

What we collect: Survey responses about household and community conditions. Contact details (name, mobile number, email) are collected only if you choose to provide them.

How your data is handled: Your individual responses are kept confidential, stored securely within Saudi Arabia, and reported only in aggregated form. Your identity will not appear in any report.

Your rights: Under the Saudi Personal Data Protection Law, you may request access to, correction of, or deletion of your personal data, and you may withdraw this consent at any time by contacting [contact channel].

Retention: Personal data is kept only as long as needed for the study, then deleted or de-identified in line with the platform''s retention policy.', 'الموافقة على جمع ومعالجة البيانات الشخصية

الغرض: تُستخدم إجاباتك لتقييم الاحتياجات التنموية في قريتك وللمساعدة في تخطيط البرامج المجتمعية. المشاركة طوعية بالكامل، ويمكنك التوقف في أي وقت.

ما نجمعه: إجابات الاستبيان حول أوضاع الأسرة والمجتمع. ولا تُجمع بيانات التواصل (الاسم، رقم الجوال، البريد الإلكتروني) إلا إذا اخترت تقديمها.

كيفية التعامل مع بياناتك: تُحفظ إجاباتك الفردية بسرية، وتُخزَّن بشكل آمن داخل المملكة العربية السعودية، ولا تُعرض في التقارير إلا بصورة مجمّعة، ولن تظهر هويتك في أي تقرير.

حقوقك: وفقاً لنظام حماية البيانات الشخصية، يحق لك طلب الاطلاع على بياناتك الشخصية أو تصحيحها أو حذفها، كما يحق لك سحب هذه الموافقة في أي وقت عبر التواصل مع [جهة التواصل].

الاحتفاظ بالبيانات: تُحفظ البيانات الشخصية للمدة اللازمة للدراسة فقط، ثم تُحذف أو تُخفى هوية أصحابها وفق سياسة الاحتفاظ المعتمدة في المنصة.', 'published'::"ConsentPolicyStatus", TRUE, now(), now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "consent_policies" WHERE "kind" = 'citizen_consent'::"ConsentPolicyKind"
);

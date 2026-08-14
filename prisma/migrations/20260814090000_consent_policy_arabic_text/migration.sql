-- RIO-DATA-001 / RIO-NFR-007 — serve the two consents in Arabic as well as
-- English, so an Arabic registrant reads the policy they are agreeing to
-- rather than English text under an Arabic label.
--
-- Shape: a sibling `text_ar` column on the SAME row, not a `locale` row per
-- language. A translation is not a separate policy — it activates, versions
-- and is superseded in lockstep with its English source — so pairing them on
-- one row makes "v1 Arabic is live but v1 English was retired" unrepresentable.
-- The row-per-locale alternative would have meant widening
-- consent_policies_kind_version_key to (kind, version, locale) and teaching
-- every "the active policy" lookup (signup validation, the public endpoint)
-- to resolve a language, for no gain.
--
-- Nullable on purpose: a policy whose Arabic copy is not ready yet must still
-- be servable, so readers fall back to `text` (see consentPolicyTextFor)
-- rather than showing an Arabic reader a blank consent.
ALTER TABLE "consent_policies" ADD COLUMN "text_ar" TEXT;

-- Which language's wording an acceptance snapshotted. Until now every
-- acceptance was English by construction (no other copy existed), which is
-- exactly what the 'en' default backfills onto existing rows — it is a
-- statement of fact about those rows, not a placeholder. NOT NULL because an
-- unlabelled snapshot is an ambiguous one: `policy_text` alone can no longer
-- tell you which text the user was shown once a policy exists in two
-- languages.
ALTER TABLE "consent_acceptances"
  ADD COLUMN "policy_locale" VARCHAR(8) NOT NULL DEFAULT 'en';

-- Arabic copy for the live v1 of each kind, mirroring
-- 20260807000000_consent_policy_real_text's in-place UPDATE rather than
-- publishing a v2: adding a translation does not change what the policy says,
-- so it must not invalidate a single existing acceptance or re-prompt anyone
-- (ConsentGuard compares accepted version against active version).
--
-- Guarded with `text_ar IS NULL` so this is a one-shot backfill: an
-- environment whose translation has already been curated by hand is left
-- alone, and re-running is a no-op.
UPDATE "consent_policies"
SET "text_ar" = 'شروط الاستخدام

مرحبًا بك في تطبيق RIO. بدخولك إلى هذه المنصة أو استخدامك لها، فإنك توافق على الشروط التالية:

يُقدَّم هذا التطبيق لأغراض العرض التوضيحي والاختبار والتقييم فقط.
يجب أن تكون أي معلومات تُدخل في التطبيق وهمية أو غير حساسة ما لم يُصرَّح بغير ذلك صراحةً.
يتحمل المستخدمون مسؤولية التأكد من أن أي محتوى يقدمونه يمتثل للأنظمة المعمول بها وسياسات الجهة.
يُحظر الوصول غير المصرح به إلى التطبيق أو إساءة استخدامه أو محاولة تعطيله.
يجوز لمالك التطبيق تعديل أي ميزة أو تعليقها أو إيقافها دون إشعار مسبق.
قد لا تمثل الميزات وسير العمل والتقارير المعروضة في هذا العرض التوضيحي النسخة الإنتاجية النهائية.
يشير استمرارك في استخدام التطبيق إلى قبولك لهذه الشروط.'
WHERE "kind" = 'use_policy'
  AND "version" = 'v1'
  AND "text_ar" IS NULL;

UPDATE "consent_policies"
SET "text_ar" = 'سياسة مشاركة البيانات

نحن نقدّر خصوصيتك ونلتزم بالتعامل مع معلوماتك بمسؤولية.

تُستخدم المعلومات المُدخلة في تطبيق Rio لأغراض العرض التوضيحي والاختبار والتقييم فقط.
لا نبيع معلوماتك ولا نشاركها مع أطراف ثالثة لأغراض تسويقية.
قد يطّلع على البيانات مسؤولون مصرَّح لهم أو موظفو الدعم لغرض صيانة التطبيق وتحسينه فقط.
قد تُستخدم المعلومات المجمّعة ومجهولة الهوية لتقييم أداء النظام وتحسين تجربة المستخدم.
ينبغي على المستخدمين تجنب إدخال معلومات سرية أو شخصية أو مالية أو خاضعة للتنظيم في هذه البيئة التجريبية.
تُطبَّق تدابير أمنية مناسبة للمساعدة في حماية البيانات؛ ومع ذلك، لا يمكن لأي نظام إلكتروني أن يضمن أمانًا مطلقًا.
باستخدامك هذا التطبيق، فإنك تقر وتوافق على جمع المعلومات ومعالجتها على النحو الموضح في هذه السياسة.'
WHERE "kind" = 'data_sharing'
  AND "version" = 'v1'
  AND "text_ar" IS NULL;

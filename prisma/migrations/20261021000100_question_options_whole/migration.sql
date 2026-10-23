-- Answer options that contain " / " in their own wording ("Yes, graded /
-- unpaved but passable", "Tanker / vendor") were imported cut into pieces, so
-- a respondent could pick a piece that has no scoring lookup and is never
-- scored. scripts/extract-methodology-v5.py (step 3b) now keeps each option
-- whole, matching the Scoring Lookup; this brings stored rows into line with
-- the regenerated question-bank-v5.json. Arabic options follow the same rule
-- (prisma/import-question-bank-arabic.ts), which also realigns HLT-05, where
-- "ممرض/ممرضة" (Nurse) had become two options.
--
-- Each update applies only while a row still holds the old value, so a row
-- that was edited since is left alone. No schema change.

UPDATE "questions" SET "answer_options" = '["Yes, actively maintained", "Exists but undocumented / at risk", "Nothing identified"]'::jsonb
  WHERE "question_id" = 'CUL-01' AND "answer_options" = '["Yes, actively maintained", "Exists but undocumented", "at risk", "Nothing identified"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Documentation", "Training apprentices", "Premises / hall", "Funding", "Raw materials", "Legal recognition", "Marketing", "Digital archiving", "Other — specify"]'::jsonb
  WHERE "question_id" = 'CUL-11' AND "answer_options" = '["Documentation", "Training apprentices", "Premises", "hall", "Funding", "Raw materials", "Legal recognition", "Marketing", "Digital archiving", "Other — specify"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Distance / safety", "Shortage of female teachers", "Early marriage", "Household burdens", "Cultural norms", "None"]'::jsonb
  WHERE "question_id" = 'EDU-07' AND "answer_options" = '["Distance", "safety", "Shortage of female teachers", "Early marriage", "Household burdens", "Cultural norms", "None"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Electricity / LPG / natural gas", "Improved stove", "Firewood / charcoal / open fire", "Other"]'::jsonb
  WHERE "question_id" = 'ENV-04' AND "answer_options" = '["Electricity", "LPG", "natural gas", "Improved stove", "Firewood", "charcoal", "open fire", "Other"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Municipality office", "National reporting platform / app", "Hotline", "Local council / village mayor", "Other — specify", "Cannot name a channel"]'::jsonb
  WHERE "question_id" = 'GOV-09' AND "answer_options" = '["Municipality office", "National reporting platform", "app", "Hotline", "Local council", "village mayor", "Other — specify", "Cannot name a channel"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Yes, paved", "Yes, graded / unpaved but passable", "No, often impassable"]'::jsonb
  WHERE "question_id" = 'INF-01' AND "answer_options" = '["Yes, paved", "Yes, graded", "unpaved but passable", "No, often impassable"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Yes, strong signal", "Weak / intermittent signal", "No coverage"]'::jsonb
  WHERE "question_id" = 'INF-05' AND "answer_options" = '["Yes, strong signal", "Weak", "intermittent signal", "No coverage"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Lack of capital", "Lack of skills / training", "No market", "Regulatory / licensing problems", "No mentoring", "Other"]'::jsonb
  WHERE "question_id" = 'LIV-10' AND "answer_options" = '["Lack of capital", "Lack of skills", "training", "No market", "Regulatory", "licensing problems", "No mentoring", "Other"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Childcare / household burdens", "Cultural / social norms", "No nearby opportunities", "Transport", "Lack of skills", "Not applicable"]'::jsonb
  WHERE "question_id" = 'LIV-16' AND "answer_options" = '["Childcare", "household burdens", "Cultural", "social norms", "No nearby opportunities", "Transport", "Lack of skills", "Not applicable"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Piped into the dwelling", "Public tap", "Protected well", "Unprotected well", "Surface water (river / pond)", "Tanker / vendor", "Other"]'::jsonb
  WHERE "question_id" = 'WSH-01' AND "answer_options" = '["Piped into the dwelling", "Public tap", "Protected well", "Unprotected well", "Surface water (river", "pond)", "Tanker", "vendor", "Other"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Flush toilet connected to a sewer or septic tank", "Pit latrine with a slab", "Pit latrine without a slab", "Shared / public facility", "Open defecation"]'::jsonb
  WHERE "question_id" = 'WSH-08' AND "answer_options" = '["Flush toilet connected to a sewer or septic tank", "Pit latrine with a slab", "Pit latrine without a slab", "Shared", "public facility", "Open defecation"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["نعم، تُصان بنشاط", "موجودة لكنها غير موثقة/معرضة للخطر", "لم يُحدد شيء"]'::jsonb
  WHERE "question_id" = 'CUL-01' AND "answer_options_ar" = '["نعم، تُصان بنشاط", "موجودة لكنها غير موثقة", "معرضة للخطر", "لم يُحدد شيء"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["توثيق", "تدريب متدربين", "مقر/قاعة", "تمويل", "مواد خام", "اعتراف قانوني", "تسويق", "أرشفة رقمية", "أخرى — حدد"]'::jsonb
  WHERE "question_id" = 'CUL-11' AND "answer_options_ar" = '["توثيق", "تدريب متدربين", "مقر", "قاعة", "تمويل", "مواد خام", "اعتراف قانوني", "تسويق", "أرشفة رقمية", "أخرى — حدد"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["المسافة/السلامة", "نقص المعلمات", "زواج مبكر", "أعباء منزلية", "أعراف ثقافية", "لا شيء"]'::jsonb
  WHERE "question_id" = 'EDU-07' AND "answer_options_ar" = '["المسافة", "السلامة", "نقص المعلمات", "زواج مبكر", "أعباء منزلية", "أعراف ثقافية", "لا شيء"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["كهرباء/غاز مسال/غاز طبيعي", "موقد محسّن", "حطب/فحم/نار مكشوفة", "أخرى"]'::jsonb
  WHERE "question_id" = 'ENV-04' AND "answer_options_ar" = '["كهرباء", "غاز مسال", "غاز طبيعي", "موقد محسّن", "حطب", "فحم", "نار مكشوفة", "أخرى"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["مكتب البلدية", "منصة/تطبيق البلاغات الوطني", "خط ساخن", "المجلس المحلي/العمدة", "أخرى — حدد", "لا يستطيع تسمية قناة"]'::jsonb
  WHERE "question_id" = 'GOV-09' AND "answer_options_ar" = '["مكتب البلدية", "منصة", "تطبيق البلاغات الوطني", "خط ساخن", "المجلس المحلي", "العمدة", "أخرى — حدد", "لا يستطيع تسمية قناة"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["طبيب", "ممرض/ممرضة", "قابلة مؤهلة", "قابلة تقليدية", "قريب أو صديق", "لا أحد", "أخرى — حدد", "لا أعلم", "أفضّل عدم الإجابة"]'::jsonb
  WHERE "question_id" = 'HLT-05' AND "answer_options_ar" = '["طبيب", "ممرض", "ممرضة", "قابلة مؤهلة", "قابلة تقليدية", "قريب أو صديق", "لا أحد", "أخرى — حدد", "لا أعلم", "أفضّل عدم الإجابة"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["نعم، معبّد", "نعم، ممهد/غير معبّد لكنه صالح", "لا، يتعذر المرور غالبًا"]'::jsonb
  WHERE "question_id" = 'INF-01' AND "answer_options_ar" = '["نعم، معبّد", "نعم، ممهد", "غير معبّد لكنه صالح", "لا، يتعذر المرور غالبًا"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["نعم، إشارة قوية", "إشارة ضعيفة/متقطعة", "لا توجد تغطية"]'::jsonb
  WHERE "question_id" = 'INF-05' AND "answer_options_ar" = '["نعم، إشارة قوية", "إشارة ضعيفة", "متقطعة", "لا توجد تغطية"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["نقص رأس المال", "نقص المهارات/التدريب", "غياب السوق", "مشكلات تنظيمية/تراخيص", "غياب الإرشاد", "أخرى"]'::jsonb
  WHERE "question_id" = 'LIV-10' AND "answer_options_ar" = '["نقص رأس المال", "نقص المهارات", "التدريب", "غياب السوق", "مشكلات تنظيمية", "تراخيص", "غياب الإرشاد", "أخرى"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["رعاية الأطفال/الأعباء المنزلية", "أعراف ثقافية/اجتماعية", "غياب الفرص القريبة", "المواصلات", "نقص المهارات", "لا ينطبق"]'::jsonb
  WHERE "question_id" = 'LIV-16' AND "answer_options_ar" = '["رعاية الأطفال", "الأعباء المنزلية", "أعراف ثقافية", "اجتماعية", "غياب الفرص القريبة", "المواصلات", "نقص المهارات", "لا ينطبق"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["أنابيب داخل المسكن", "صنبور عام", "بئر محمية", "بئر غير محمية", "مياه سطحية (نهر/بركة)", "صهريج/بائع", "أخرى"]'::jsonb
  WHERE "question_id" = 'WSH-01' AND "answer_options_ar" = '["أنابيب داخل المسكن", "صنبور عام", "بئر محمية", "بئر غير محمية", "مياه سطحية (نهر", "بركة)", "صهريج", "بائع", "أخرى"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["مرحاض شطف موصول بشبكة صرف أو خزان تحليل", "مرحاض حفرة ببلاطة", "مرحاض حفرة بدون بلاطة", "مرفق مشترك/عام", "التغوط في العراء"]'::jsonb
  WHERE "question_id" = 'WSH-08' AND "answer_options_ar" = '["مرحاض شطف موصول بشبكة صرف أو خزان تحليل", "مرحاض حفرة ببلاطة", "مرحاض حفرة بدون بلاطة", "مرفق مشترك", "عام", "التغوط في العراء"]'::jsonb;
UPDATE "questions" SET "answer_options_ar" = '["Relationship;knowledgeable for module: Yes/No;proxy: Yes/No"]'::jsonb
  WHERE "question_id" = 'XDM-05' AND "answer_options_ar" = '["Relationship;knowledgeable for module: Yes", "No;proxy: Yes", "No"]'::jsonb;

-- Second part: options the Question Bank writes as a short form of the
-- Scoring Lookup wording in the same BRD workbook ("30–60" for "30–60
-- minutes", "Other — specify" for "Other", a workbook note left on the
-- option). They take the Scoring Lookup's exact wording (extractor step 3c),
-- so a respondent's choice is scored. Arabic options keep their positions.
UPDATE "questions" SET "answer_options" = '["Yes — regularly", "Yes — sometimes", "No", "Prefer not to answer"]'::jsonb
  WHERE "question_id" = 'CUL-13' AND "answer_options" = '["Yes — regularly", "Yes — sometimes", "No", "Prefer not to answer; activity type recorded"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["No", "Missed school", "Delayed enrolment", "Lacked supplies or uniform", "Other", "Prefer not to answer"]'::jsonb
  WHERE "question_id" = 'EDU-18' AND "answer_options" = '["No", "Missed school", "Delayed enrolment", "Lacked supplies or uniform", "Other — specify", "Prefer not to answer"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["24 hours", "20–23 hours", "12–19 hours", "Less than 12 hours"]'::jsonb
  WHERE "question_id" = 'ENV-12' AND "answer_options" = '["24 hours", "20–23", "12–19", "<12"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Waste burning", "Industrial source", "Sewage or stagnant water", "Dust or quarrying", "Agricultural chemicals", "None", "Other"]'::jsonb
  WHERE "question_id" = 'ENV-17' AND "answer_options" = '["Waste burning", "Industrial source", "Sewage or stagnant water", "Dust or quarrying", "Agricultural chemicals", "None", "Other — specify"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Modifying the dwelling", "Water storage", "Changing crops", "Insurance or saving", "Using early warning", "Relocating", "None", "Other"]'::jsonb
  WHERE "question_id" = 'ENV-18' AND "answer_options" = '["Modifying the dwelling", "Water storage", "Changing crops", "Insurance or saving", "Using early warning", "Relocating", "None", "Other — specify"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Always", "Usually", "Sometimes", "Never", "No relevant information was needed"]'::jsonb
  WHERE "question_id" = 'GOV-14' AND "answer_options" = '["Always", "Usually", "Sometimes", "Never", "No relevant information was needed; information-source list recorded"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Under 30 minutes", "30–60 minutes", "60–120 minutes", "More than 120 minutes", "Don''t know"]'::jsonb
  WHERE "question_id" = 'HLT-16' AND "answer_options" = '["Under 30 minutes", "30–60", "60–120", ">120", "Don''t know"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Owned", "Rented (formal)", "Provided by relatives / employer", "No formal arrangement"]'::jsonb
  WHERE "question_id" = 'INF-19' AND "answer_options" = '["Owned", "Rented (formal)", "Provided by relatives-employer", "No formal arrangement"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Savings", "Borrowing", "Selling assets", "Cutting back on food or essentials", "External support", "No coping mechanism was needed", "Other"]'::jsonb
  WHERE "question_id" = 'LIV-24' AND "answer_options" = '["Shock types;coping: Savings", "Borrowing", "Selling assets", "Cutting back on food or essentials", "External support", "No coping mechanism was needed", "Other — specify"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Sewer network", "Septic tank or soakaway pit", "Covered drain", "Open drain", "Open ground", "Reused", "Other", "Don''t know"]'::jsonb
  WHERE "question_id" = 'WSH-16' AND "answer_options" = '["Sewer network", "Septic tank or soakaway pit", "Covered drain", "Open drain", "Open ground", "Reused", "Other — specify", "Don''t know"]'::jsonb;
UPDATE "questions" SET "answer_options" = '["Job loss", "Illness or death", "Price shock", "Natural disaster", "Displacement", "Conflict", "Other", "None"]'::jsonb
  WHERE "question_id" = 'XDM-08' AND "answer_options" = '["Job loss", "Illness or death", "Price shock", "Natural disaster", "Displacement", "Conflict", "Other — specify", "None"]'::jsonb;

import type { AppLocale } from './locale';

/**
 * Report chrome, translated by matching the English string.
 *
 * WHY A STRING MAP AND NOT MESSAGE KEYS
 *
 * `buildReportDoc` (reports/report-doc.ts, ~2,400 lines) emits roughly 220
 * distinct headings, row labels and column headers as inline English literals
 * across a few hundred call sites. Converting every one of them to a
 * `t("...")` call is the textbook fix and is still the right end state — but it
 * is a large, risky, all-or-nothing edit, and it would translate nothing until
 * the last site was converted.
 *
 * This map buys the same outcome incrementally. `localiseReportDoc` walks the
 * finished document and substitutes any chrome string it recognises, so:
 *
 *  - Every report type is covered at once, including the four that have no
 *    generator yet — they will emit the same vocabulary when they are written.
 *  - Reports ALREADY STORED render in Arabic with no regeneration. The chrome
 *    is produced at export time from stored data, so history is covered too.
 *  - An unrecognised string falls through to English rather than breaking. The
 *    dictionary can grow one entry at a time, and a missing entry degrades to
 *    today's behaviour instead of a crash or a blank label.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER
 *
 *  - AI narrative prose. That is generated in one language and cannot be
 *    substituted here; it needs the prompt work (RIO-I18N-003 §3).
 *  - Reference data — domain, sub-domain, KPI, region, governorate and centre
 *    names. Those are the client's authoritative vocabulary and belong in
 *    `nameAr` columns, not in a lookup table written by us (§6, rows 6-8).
 *
 * TRANSLATION STATUS: drafted, NOT yet reviewed by a native speaker or signed
 * off by the client. Do not put an Arabic export in front of NCNP until it has
 * been through that review.
 */

/**
 * English chrome → Arabic. Keys are matched after whitespace normalisation, so
 * an em-dash or double space in the source does not cause a miss.
 */
const ar: Record<string, string> = {
  // ── Section headings ──
  'Summary': 'الملخص',
  'Header': 'الترويسة',
  'Overview': 'نظرة عامة',
  'Report Basis': 'أساس التقرير',
  'Scope Basis': 'أساس النطاق',
  'Scope': 'النطاق',
  'Data-Collection Scope': 'نطاق جمع البيانات',
  'Geographic Scope': 'النطاق الجغرافي',
  'Region Scope': 'نطاق المنطقة',
  'Partial Scope': 'نطاق جزئي',
  'AI Summary': 'ملخص الذكاء الاصطناعي',
  'Executive Summary': 'الملخص التنفيذي',
  'Key Findings': 'أبرز النتائج',
  'Risks / Concerns': 'المخاطر / المخاوف',
  'Supporting Statements': 'الإفادات الداعمة',
  'Document Limitations': 'حدود المستند',
  'Domain Detail': 'تفاصيل المجال',
  'Indicator Detail': 'تفاصيل المؤشر',

  // ── Report titles, as the generators compose them ──
  // The title arrives as "<Report Name> — <subject>"; only the name half is
  // chrome. localiseReportDoc translates the leading segment and leaves the
  // subject (a study or village name, already in the author's own language)
  // exactly as written.
  'Individual Survey Report': 'تقرير الاستبيان الفردي',
  'Collective Report': 'التقرير الجماعي',
  'Top-Priority Report': 'تقرير الأولويات العليا',
  'Domain-wise Needs Report': 'تقرير الاحتياجات حسب المجال',
  'Governorate-wise Needs Report': 'تقرير الاحتياجات حسب المحافظة',
  'Gender-wise Needs Report': 'تقرير الاحتياجات حسب الجنس',
  'Region Report': 'تقرير المنطقة',
  // region.generator.ts composes the title as "Regional Needs Report — …",
  // which is NOT the catalogue name above. The mismatch left the most
  // prominent line of every Arabic RPT06 — its cover title, repeated in the
  // footer — in English. Both spellings are kept: the generator's wording is
  // what stored reports carry, and changing it would strand them.
  'Regional Needs Report': 'تقرير الاحتياجات الإقليمية',
  'Data-Quality Report': 'تقرير جودة البيانات',
  'Executive Summary Report': 'تقرير الملخص التنفيذي',
  'Village Report': 'تقرير القرية',
  'Survey & Dashboard Report': 'تقرير الاستبيان ولوحة المعلومات',
  'Combined Evidence & Score Report': 'تقرير الأدلة والدرجات المجمّع',
  'Evidence Document-Based Report': 'التقرير المبني على مستندات الأدلة',
  'Report Sharing Status': 'حالة مشاركة التقارير',
  'Priority Ranking': 'ترتيب الأولويات',
  'KPI Results': 'نتائج مؤشرات الأداء',
  'Previous Studies View': 'عرض الدراسات السابقة',
  'Combined Executive Summary': 'الملخص التنفيذي المجمّع',
  'Score-Based Executive Summary': 'الملخص التنفيذي المبني على الدرجات',
  'Score-Based Findings': 'النتائج المبنية على الدرجات',
  'Score-Based Key Findings': 'أبرز النتائج المبنية على الدرجات',
  'Recommendations': 'التوصيات',
  'Conclusions & Recommendations': 'الاستنتاجات والتوصيات',
  'Needs Index': 'مؤشر الاحتياجات',
  'Assessment Coverage': 'تغطية التقييم',
  'Coverage': 'التغطية',
  'Demographic Breakdown': 'التوزيع الديموغرافي',
  'Demographics': 'البيانات الديموغرافية',
  'Gender Breakdown': 'التوزيع حسب الجنس',
  'Geographic Breakdown': 'التوزيع الجغرافي',
  'Rural / Urban Breakdown': 'التوزيع الريفي / الحضري',
  'Domain Profile': 'ملف المجال',
  'Domain Rollup': 'تجميع المجالات',
  'Domain Insights': 'رؤى المجالات',
  'Domains': 'المجالات',
  'Domain Masking Alert': 'تنبيه إخفاء المجال',
  'Domains — Domain Masking Alert': 'المجالات — تنبيه إخفاء المجال',
  'Geographic Masking Alert': 'تنبيه الإخفاء الجغرافي',
  'Domains Not Assessed': 'مجالات لم تُقيَّم',
  'Domain Coverage (all methodology domains)': 'تغطية المجالات (جميع مجالات المنهجية)',
  'Domain / KPI Results': 'نتائج المجالات ومؤشرات الأداء',
  'Domain to indicator detail': 'تفصيل المجال إلى المؤشر',
  'Severity by Domain': 'الشدة حسب المجال',
  'Confidence by Domain': 'مستوى الثقة حسب المجال',
  'Questions per Domain': 'الأسئلة لكل مجال',
  'Methodology Hierarchy': 'التسلسل المنهجي',
  'Needs by Domain, Sub-domain and Indicator': 'الاحتياجات حسب المجال والمجال الفرعي والمؤشر',
  'Sub-domains and Indicators': 'المجالات الفرعية والمؤشرات',
  'Indicators With No Measurable Response': 'مؤشرات بلا استجابة قابلة للقياس',
  'KPIs under this Indicator': 'مؤشرات الأداء ضمن هذا المؤشر',
  'Calculation Basis': 'أساس الاحتساب',
  'Calculation Basis — Thresholds Applied': 'أساس الاحتساب — الحدود المطبقة',
  'Calculation Basis — Needs Index working': 'أساس الاحتساب — طريقة حساب مؤشر الاحتياجات',
  'How severity is aggregated': 'كيفية تجميع درجات الشدة',
  'How this is counted': 'كيفية احتساب هذا',
  'Data Quality': 'جودة البيانات',
  'Data Quality Note': 'ملاحظة على جودة البيانات',
  'Data Quality Notes': 'ملاحظات على جودة البيانات',
  'Data Quality Summary': 'ملخص جودة البيانات',
  'Completeness & Confidence': 'الاكتمال ومستوى الثقة',
  'Response Quality': 'جودة الاستجابات',
  'Response Funnel': 'مسار الاستجابات',
  'Invalid Responses': 'الاستجابات غير الصالحة',
  'Flagged Records': 'السجلات المُعلَّمة',
  'Flagged Records Detail': 'تفاصيل السجلات المُعلَّمة',
  'Anomalies Flagged': 'الحالات الشاذة المُعلَّمة',
  'Dashboard Anomalies': 'الحالات الشاذة في لوحة المعلومات',
  'Required-Question Gaps': 'فجوات الأسئلة الإلزامية',
  'Required Questions With Gaps': 'الأسئلة الإلزامية ذات الفجوات',
  'Unanswered Required Questions': 'أسئلة إلزامية بلا إجابة',
  'Answer Status Breakdown': 'توزيع حالة الإجابات',
  'Survey Abandonment': 'التخلي عن الاستبيان',
  'Reading the Abandonment Figures': 'قراءة أرقام التخلي',
  'Where Respondents Stopped': 'أين توقف المستجيبون',
  'Priority': 'الأولوية',
  'Priority Explanation': 'تفسير الأولوية',
  'Priority Needs': 'الاحتياجات ذات الأولوية',
  'Priority Needs — How this ranking was produced': 'الاحتياجات ذات الأولوية — كيف أُنتج هذا الترتيب',
  'Priority Needs — Reading these columns': 'الاحتياجات ذات الأولوية — قراءة هذه الأعمدة',
  'Priority Tier Summary': 'ملخص مستويات الأولوية',
  'Needs by Priority Tier': 'الاحتياجات حسب مستوى الأولوية',
  'Critical Override': 'التجاوز الحرج',
  'Village Priority': 'أولوية القرية',
  'Worst Village': 'القرية الأكثر تأثرًا',
  'Organisation Dashboard': 'لوحة معلومات المؤسسة',
  'Organisation Portfolio': 'محفظة المؤسسة',
  'Organisation Scoring Distribution': 'توزيع الدرجات في المؤسسة',
  'Organisation Top Priorities': 'أعلى أولويات المؤسسة',
  'Scoring Distribution': 'توزيع الدرجات',
  'Top Priorities': 'أعلى الأولويات',
  'Top Domains / KPIs': 'أبرز المجالات ومؤشرات الأداء',
  'Top KPIs': 'أبرز مؤشرات الأداء',
  'Collective KPIs': 'مؤشرات الأداء الجماعية',
  'Dashboard KPIs': 'مؤشرات لوحة المعلومات',
  'This Survey vs. Organisation': 'هذا الاستبيان مقارنة بالمؤسسة',
  'Comparison': 'المقارنة',
  'Comparison Detail': 'تفاصيل المقارنة',
  'Pattern Analysis': 'تحليل الأنماط',
  'Pattern & Intersection Analysis': 'تحليل الأنماط والتقاطعات',
  'Observed Patterns': 'الأنماط الملاحظة',
  'Evidence': 'الأدلة',
  'Evidence Base': 'قاعدة الأدلة',
  'Evidence Documents': 'مستندات الأدلة',
  'Evidence Document Register': 'سجل مستندات الأدلة',
  'Document-Based Evidence': 'الأدلة المبنية على المستندات',
  'Documents by Type': 'المستندات حسب النوع',
  'Themes Across Documents': 'الموضوعات عبر المستندات',
  'Sharing': 'المشاركة',
  'Sharing Summary': 'ملخص المشاركة',
  'Sharing Requests': 'طلبات المشاركة',
  'Reviewer Notes': 'ملاحظات المراجع',
  'Reviewer SLA Compliance': 'الالتزام باتفاقية مستوى خدمة المراجعة',
  'Trend Note': 'ملاحظة على الاتجاه',
  'Trend': 'الاتجاه',
  'Drill-down Index': 'فهرس التفصيل',
  'Drill-down Index — Domains': 'فهرس التفصيل — المجالات',
  'Drill-down by Domain': 'التفصيل حسب المجال',
  'Additional Detail': 'تفاصيل إضافية',
  'All Need Records': 'جميع سجلات الاحتياجات',
  'Region / Governorate': 'المنطقة / المحافظة',
  'Audit Trail': 'سجل التدقيق',

  // ── Column headers seen in a real RPT13 Arabic export that the first pass
  // missed. Dynamic column sets are assembled per report, so this list grows
  // from observed output rather than from a single source file. ──
  'Rank': 'الترتيب',
  // Seen in English in a real RPT06 export: it is a COLUMN HEADER here, while
  // the identical word also exists as a severity band VALUE. They live in
  // different positions, so both can be translated without colliding.
  'Critical': 'حرج',
  'Not Calculable Reason': 'سبب تعذر الاحتساب',
  'Override Applied': 'تم تطبيق التجاوز',
  'Override Reason': 'سبب التجاوز',
  'Max KPI Severity Column': 'عمود أعلى شدة لمؤشر أداء',
  'Worst KPI': 'أسوأ مؤشر أداء',
  'Severity Score': 'درجة الشدة',
  'Not Measured Reason': 'سبب عدم القياس',
  'Valid Response Count': 'عدد الاستجابات الصالحة',
  'Excluded Response Count': 'عدد الاستجابات المستبعدة',
  'Consolidated Governorates': 'المحافظات المجمّعة',
  'Confidence Reason': 'سبب مستوى الثقة',
  'Severity Band': 'نطاق الشدة',
  'Domain Name': 'اسم المجال',
  'Indicator Name': 'اسم المؤشر',
  'Sub-Domain': 'المجال الفرعي',
  // Headings that carry their own scale in the text. Matched whole, so the
  // "(0-100)" travels with the translation rather than being stranded. Western
  // digits, consistent with every other figure in the report — Arabic-Indic
  // numerals are still an open client question (RIO-I18N-003 §11).
  'Domain Severity (0-100)': 'شدة المجال (0-100)',

  // ── Audit-header labels ──
  // Duplicated from messages.ts on purpose: auditMetaLines already emits these
  // translated, but a ReportDoc assembled by any other path (the NCNP report
  // renderer, a future generator) arrives with the English wording, and the
  // walker should translate it rather than leave one English block in an
  // otherwise-Arabic document.
  'Generated At': 'تاريخ الإنشاء',
  'Generated By': 'أنشأه',
  'Study': 'الدراسة',
  'Officer Confirmed By': 'اعتمده الموظف',
  'Officer Confirmed At': 'تاريخ اعتماد الموظف',
  'Reviewed By': 'راجعه',
  'Reviewer Role': 'دور المراجع',
  'Reviewed At': 'تاريخ المراجعة',
  'Archived At': 'تاريخ الأرشفة',
  'Language Edition': 'نسخة اللغة',

  // ── Row labels and table column headers ──
  'Study Name': 'اسم الدراسة',
  'Entity Name': 'اسم الجهة',
  'Report Generated At': 'تاريخ إنشاء التقرير',
  'Methodology Version': 'إصدار المنهجية',
  'Assessment Cycle': 'دورة التقييم',
  'Assessment Period': 'فترة التقييم',
  'Report type': 'نوع التقرير',
  'Version': 'الإصدار',
  'Status': 'الحالة',
  'Level': 'المستوى',
  'Basis': 'الأساس',
  'Source basis': 'أساس المصدر',
  'Coverage basis': 'أساس التغطية',
  'Explicit filter': 'مرشِّح صريح',
  'Selected by': 'اختير بواسطة',
  'Latest published survey': 'أحدث استبيان منشور',
  'Survey': 'الاستبيان',
  'Surveys': 'الاستبيانات',
  'Surveys in study': 'الاستبيانات في الدراسة',
  'Surveys Covered': 'الاستبيانات المشمولة',
  'Surveys NOT Covered': 'الاستبيانات غير المشمولة',
  'Surveys covered by these figures': 'الاستبيانات التي تغطيها هذه الأرقام',
  'Survey links': 'روابط الاستبيان',
  'Survey level': 'مستوى الاستبيان',
  'Study level': 'مستوى الدراسة',
  'This survey': 'هذا الاستبيان',
  'Studies': 'الدراسات',
  'Organisation': 'المؤسسة',
  'Reports': 'التقارير',
  'Domain': 'المجال',
  'Sub-domain': 'المجال الفرعي',
  'Sub-domains': 'المجالات الفرعية',
  'Indicator': 'المؤشر',
  'Indicators': 'المؤشرات',
  'Indicator ID': 'معرّف المؤشر',
  'KPI': 'مؤشر الأداء',
  'KPIs': 'مؤشرات الأداء',
  'KPIs defined': 'مؤشرات الأداء المعرَّفة',
  'KPIs Defined': 'مؤشرات الأداء المعرَّفة',
  'KPIs scored': 'مؤشرات الأداء المُقيَّمة',
  'Critical KPIs': 'مؤشرات الأداء الحرجة',
  'Code': 'الرمز',
  'Need': 'الاحتياج',
  'Needs': 'الاحتياجات',
  'Needs in study': 'الاحتياجات في الدراسة',
  'Needs extracted': 'الاحتياجات المستخرجة',
  'Needs with no governorate link': 'احتياجات بلا ارتباط بمحافظة',
  'Linked Need / Domain': 'الاحتياج / المجال المرتبط',
  'Classification': 'التصنيف',
  'Severity': 'الشدة',
  'Avg Severity': 'متوسط الشدة',
  'Max KPI Severity': 'أعلى شدة لمؤشر أداء',
  'Overall Severity Score': 'درجة الشدة الإجمالية',
  'Severity banding': 'تصنيف نطاقات الشدة',
  'Performance': 'الأداء',
  'Performance Score': 'درجة الأداء',
  'Priority Score': 'درجة الأولوية',
  'Priority Status': 'حالة الأولوية',
  'Priority Tier': 'مستوى الأولوية',
  'Priority Contribution': 'المساهمة في الأولوية',
  'Village Priority Score': 'درجة أولوية القرية',
  'Weight': 'الوزن',
  'Weighted Contribution': 'المساهمة المرجّحة',
  'Confidence': 'مستوى الثقة',
  'Confidence / Data Quality': 'مستوى الثقة / جودة البيانات',
  'Overall confidence': 'مستوى الثقة الإجمالي',
  'Band': 'النطاق',
  'Why this band': 'سبب هذا النطاق',
  'Score direction': 'اتجاه الدرجة',
  'Masking?': 'إخفاء؟',
  'Override': 'تجاوز',
  'Reason': 'السبب',
  'Why': 'السبب',
  'Why not measured': 'سبب عدم القياس',
  'Why fewer than three': 'سبب وجود أقل من ثلاثة',
  'Not measured': 'غير مقيس',
  'Not Measured (excluded from ranking)': 'غير مقيس (مستبعد من الترتيب)',
  'Equity': 'الإنصاف',
  'Equity flag': 'مؤشر الإنصاف',
  'Equity-flagged': 'مُعلَّم بمؤشر الإنصاف',
  'Intersections (equity)': 'التقاطعات (الإنصاف)',
  'Most disadvantaged': 'الأكثر حرمانًا',
  'Gap type': 'نوع الفجوة',
  'Finding': 'النتيجة',
  'Flag': 'العلامة',
  'Pattern': 'النمط',
  'Strength': 'القوة',
  'Relevance': 'الصلة',
  'Notes': 'ملاحظات',
  'Share': 'الحصة',
  'Rate': 'المعدل',
  'Valid': 'صالحة',
  'Valid %': 'نسبة الصالحة',
  'Valid responses': 'الاستجابات الصالحة',
  'Valid-Response Rate': 'معدل الاستجابات الصالحة',
  'Valid-response rate': 'معدل الاستجابات الصالحة',
  'Responses': 'الاستجابات',
  'Responses (all studies)': 'الاستجابات (جميع الدراسات)',
  'Responses submitted': 'الاستجابات المُرسلة',
  'Responses with no session record': 'استجابات بلا سجل جلسة',
  'Submitted': 'مُرسلة',
  'Submitted Responses': 'الاستجابات المُرسلة',
  'Submitted responses': 'الاستجابات المُرسلة',
  'Excluded': 'مستبعدة',
  'Excluded responses': 'الاستجابات المستبعدة',
  'Excluded submitted responses': 'الاستجابات المُرسلة المستبعدة',
  'Invalid responses (total)': 'الاستجابات غير الصالحة (الإجمالي)',
  'Flagged responses': 'الاستجابات المُعلَّمة',
  'Low-confidence responses': 'استجابات منخفضة الثقة',
  'Duplicates flagged': 'التكرارات المُعلَّمة',
  'Answers': 'الإجابات',
  '% of answers': 'نسبة الإجابات',
  'Of Responses': 'من الاستجابات',
  'Left Blank': 'تُركت فارغة',
  'Left blank': 'تُركت فارغة',
  "Don't-Know Rate": 'نسبة «لا أعرف»',
  "Don't-know rate": 'نسبة «لا أعرف»',
  "Don't-know band": 'نطاق «لا أعرف»',
  "Don't-know rate that forces LOW confidence": 'نسبة «لا أعرف» التي تفرض ثقة منخفضة',
  'Questions Asked': 'الأسئلة المطروحة',
  'Questions asked': 'الأسئلة المطروحة',
  'Required Question': 'سؤال إلزامي',
  'Required questions in scope': 'الأسئلة الإلزامية ضمن النطاق',
  'Required answers expected': 'الإجابات الإلزامية المتوقعة',
  'Sessions': 'الجلسات',
  'Sessions started': 'الجلسات التي بدأت',
  'Still in progress': 'قيد الإنجاز',
  'Stopped at': 'توقفت عند',
  'Abandoned': 'متروكة',
  'Abandoned / incomplete sessions': 'الجلسات المتروكة / غير المكتملة',
  'Abandonment rate': 'معدل التخلي',
  'Share of abandoned': 'حصة المتروكة',
  'Mean progress when abandoned': 'متوسط التقدم عند التخلي',
  'Completion rate': 'معدل الإكمال',
  'Idle threshold': 'حد الخمول',
  'Reminders sent': 'التذكيرات المُرسلة',
  'Region': 'المنطقة',
  'Governorate': 'المحافظة',
  'Governorate(s)': 'المحافظات',
  'Governorates': 'المحافظات',
  'Governorates covered': 'المحافظات المشمولة',
  'Center': 'المركز',
  'Location': 'الموقع',
  'Village': 'القرية',
  'Village(s)': 'القرى',
  'Villages': 'القرى',
  'Villages covered': 'القرى المشمولة',
  'Villages not yet scored': 'قرى لم تُقيَّم بعد',
  'Mapped coverage': 'التغطية المرتبطة',
  'Assessed': 'مُقيَّم',
  'Domains assessed': 'المجالات المُقيَّمة',
  'Domains scored': 'المجالات المُقيَّمة بالدرجات',
  'Affected Pop.': 'السكان المتأثرون',
  'Population (area)': 'عدد السكان (المنطقة)',
  'Required sample size': 'حجم العينة المطلوب',
  'Minimum detectable effect': 'أصغر أثر قابل للكشف',
  'Minimum size of each compared group': 'أصغر حجم لكل مجموعة مقارنة',
  'Minimum valid responses for STANDARD confidence': 'أقل عدد استجابات صالحة للثقة القياسية',
  'Severity at or above which a gap is acute': 'الشدة التي تُعد عندها الفجوة حادة',
  'Severity at or above which a sustained gap is chronic': 'الشدة التي تُعد عندها الفجوة المستمرة مزمنة',
  'Severity spread that trips the equity flag': 'تباين الشدة الذي يُفعّل مؤشر الإنصاف',
  'Documents': 'المستندات',
  'Documents attached': 'المستندات المرفقة',
  'Total Documents': 'إجمالي المستندات',
  'Evidence type': 'نوع الدليل',
  'With AI summary': 'مع ملخص الذكاء الاصطناعي',
  'Summary Status': 'حالة الملخص',
  'Summary Status Breakdown': 'توزيع حالة الملخصات',
  'Officer confirmed': 'اعتمده الموظف',
  'Qualitative': 'نوعي',
  'Quantitative': 'كمي',
  'Sharing requests': 'طلبات المشاركة',
  'None': 'لا يوجد',
  'Yes': 'نعم',
  'No': 'لا',
};

/**
 * Values — as opposed to labels — that are OUR OWN rendering of a closed
 * vocabulary rather than data.
 *
 * Kept separate from the chrome map above, and applied only by EXACT whole-cell
 * match, because value positions are where real data lives. A partial or
 * substring match here would eventually rewrite somebody's village name.
 *
 * Every entry is a string the platform itself composes from an enum — a
 * severity band, a confidence flag, a boolean — which is why translating it is
 * correct rather than presumptuous. The bands stay English AT REST (the scoring
 * code, the prompts and the database all agree on them); this is the render
 * boundary, and the only place they become Arabic (RIO-I18N-003 §6 row 2).
 */
const arValues: Record<string, string> = {
  CRITICAL: 'حرج',
  HIGH: 'مرتفع',
  MEDIUM: 'متوسط',
  LOW: 'منخفض',
  STANDARD: 'قياسي',

  // ── Level badges, rendered in capitals as a table's "type" column ──
  //
  // These are the platform's own rendering of an enum, which is exactly what
  // this closed vocabulary is for — and they are worth having here rather than
  // leaving to the AI pass because they repeat in every row of every hierarchy
  // table in the catalogue. Their capitalisation is typography, not a signal
  // that they are machine vocabulary: each one is an English word a reader
  // reads (RIO-I18N-007).
  DOMAIN: 'مجال',
  'SUB-DOMAIN': 'مجال فرعي',
  INDICATOR: 'مؤشر',
  KPI: 'مؤشر أداء',
  SURVEY: 'استبيان',
  SCORED: 'مُقيَّم',
  ASSESSED: 'مُقيَّم',
  'NOT ASSESSED': 'غير مُقيَّم',
  PUBLISHED: 'منشور',
  ABANDONED: 'متروك',
  SESSION: 'جلسة',
  QUANTITATIVE: 'كمي',
  QUALITATIVE: 'نوعي',
  Critical: 'حرج',
  High: 'مرتفع',
  Medium: 'متوسط',
  Low: 'منخفض',
  Standard: 'قياسي',
  Yes: 'نعم',
  No: 'لا',
  YES: 'نعم',
  NO: 'لا',
  None: 'لا يوجد',
  'n/a': 'غير منطبق',
  'N/A': 'غير منطبق',
  '—': '—',
  'Not measured': 'غير مقيس',
  'Not assessed': 'غير مقيّم',
  'Not available': 'غير متوفر',
  negligible: 'ضئيلة',
  moderate: 'متوسطة',
  elevated: 'مرتفعة',
  high: 'عالية',
  'Latest published survey': 'أحدث استبيان منشور',
  released: 'مُطلق',
  draft: 'مسودة',
  submitted: 'مُرسل',
  archived: 'مؤرشف',
  rejected: 'مرفوض',
  'YES — read Max, not Avg': 'نعم — اقرأ الأعلى، لا المتوسط',
  Qualitative: 'نوعي',
  Quantitative: 'كمي',
  // Demographic enums. These reach the report as chart slice labels, which are
  // normally left alone because they usually hold reference-data names — but
  // these particular values are the platform's own rendering of a Gender /
  // SettlementType enum, so an exact whole-string match is safe here for the
  // same reason it is safe in a table cell.
  Male: 'ذكور',
  Female: 'إناث',
  Other: 'أخرى',
  'Prefer not to say': 'يفضل عدم الإفصاح',
  Rural: 'ريفي',
  Urban: 'حضري',
  Unknown: 'غير معروف',
};

/** English is the identity map — chrome is authored in English. */
export function reportChrome(locale: AppLocale): Record<string, string> {
  return locale === 'ar' ? ar : {};
}

/** Closed-vocabulary VALUES, matched whole-cell only. See `arValues`. */
export function reportValueVocabulary(locale: AppLocale): Record<string, string> {
  return locale === 'ar' ? arValues : {};
}

/** Collapses whitespace so an em-dash spacing or double space cannot cause a
 *  lookup miss on an otherwise-known string. */
export function chromeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Fixed Arabic wording for the "Calculation Basis" rules every scored report
// carries (providers/build-unified-rpt01.ts, providers/derive-gap-type.ts).
//
// These are sentences the code writes, not prose a person or a model wrote, so
// they get an exact translation instead of a machine one. Through the AI they
// came back either untranslated (the quality check rejects text dense with
// figures and capitalised terms) or mangled — "Σ" printed as "Sum" inside the
// Arabic, the ≥ thresholds out of order. Each pattern mirrors its English
// template and carries the report's own thresholds across unchanged.
//
// Keep in step with the English templates: a reworded template simply stops
// matching and falls back to the AI translation, it never prints wrong text.

type Rule = { match: RegExp; ar: (m: RegExpMatchArray) => string };

const N = String.raw`(\d+(?:\.\d+)?)`;

const RULES: Rule[] = [
  {
    match:
      /^Needs Index = mean of the measured DOMAIN severities\. A domain is the mean of its measured sub-domains, a sub-domain the mean of its measured indicators, an indicator the mean of its measured KPIs, a KPI the mean of its scored answers\. Unmeasured levels are skipped at every step, never counted as 0\.$/,
    ar: () =>
      "مؤشر الاحتياجات. يُحسب مؤشر الاحتياجات بمتوسط شدة الاحتياج في المجالات التي شملها القياس. وتُحسب شدة المجال بمتوسط شدة مجالاته الفرعية، وشدة المجال الفرعي بمتوسط شدة مؤشراته، وشدة المؤشر بمتوسط شدة مؤشراته الفرعية، وشدة المؤشر الفرعي بمتوسط درجات الإجابات المحتسبة. تُستبعد العناصر التي لم تُقَس من الحساب في كل مستوى.",
  },
  {
    match:
      /^Priority Score = Σ\(\(100 − domain severity\) × domain weight\) renormalised over the assessed domains' weight sum\. Performance-based, so LOWER means more urgent\.$/,
    ar: () =>
      "درجة الأولوية. لكل مجال شمله التقييم، تُطرح شدة الاحتياج من 100، ثم تُضرب النتيجة في وزن المجال. تُجمع النتائج وتُقسم على مجموع أوزان المجالات التي شملها التقييم. كلما انخفضت درجة الأولوية، زاد إلحاح الاحتياج.",
  },
  {
    match: new RegExp(
      String.raw`^Severity 0–100 \(higher = worse\): ≥${N} CRITICAL, ≥${N} HIGH, ≥${N} MEDIUM, <${N} LOW\. A measured 0 is LOW; an unmeasured indicator is null and shown as '—'\.$`,
    ),
    ar: (m) =>
      `شدة الاحتياج. تتراوح شدة الاحتياج من 0 إلى 100، وتشير الدرجة الأعلى إلى احتياج أشد. يُحدَّد المستوى بالترتيب: حرجة عند ${m[1]} أو أكثر، ثم عالية عند ${m[2]} أو أكثر، ثم متوسطة عند ${m[3]} أو أكثر، ومنخفضة إذا كانت الدرجة أقل من ${m[4]}. إذا كانت الدرجة المقيسة 0، فتُصنّف الشدة على أنها منخفضة. ويُعرض الرمز «—» للمؤشر الذي لم يُقَس.`,
  },
  {
    match: new RegExp(
      String.raw`^Confidence is LOW when valid responses < ${N} OR the don't-know rate > ${N}%; otherwise STANDARD\. The stated reason names only the condition that actually fired\.$`,
    ),
    ar: (m) =>
      `موثوقية البيانات. تُصنّف موثوقية البيانات على أنها منخفضة إذا قلّ عدد الإجابات الصالحة عن ${m[1]} أو تجاوزت نسبة إجابات «لا أعرف» ${m[2]}%. وفي الحالات الأخرى، تُصنّف على أنها قياسية. يوضح التقرير الشرط الذي تحقق فعليًا.`,
  },
  {
    match: new RegExp(
      String.raw`^Equity flag fires when the severity spread \(max − min\) across a dimension's groups ≥ ${N} points AND every compared group has n ≥ ${N}\. When no dimension clears the group minimum the flag is false and the reason says the sample was too small — it is not a finding of no inequity\.$`,
    ),
    ar: (m) =>
      `تنبيه التفاوت بين الفئات. يظهر التنبيه إذا بلغ الفرق بين أعلى وأدنى درجة شدة بين فئات أحد الأبعاد ${m[1]} نقطة أو أكثر، وكان عدد المشاركين في كل فئة مشمولة بالمقارنة ${m[2]} على الأقل. إذا لم يستوفِ أي بُعد الحدّ الأدنى لحجم العينة في فئاته، يعرض التقرير سبب عدم ظهور التنبيه، وهو عدم كفاية حجم العينة لتقييم التفاوت.`,
  },
  // "ثم" (then) rather than arrows: the PDF renderer mirrors an arrow laid out
  // right to left, so "←" printed pointing back at the previous step.
  {
    match: new RegExp(
      String.raw`^gap_type precedence: methodology hint → inequality \(equity flag\) → acute \(severity ≥ ${N}\) → chronic \(severity ≥ ${N} in this AND the prior cycle\) → structural → not classified \(severity not measured\)\. "Seasonal" is never inferred from a single assessment cycle\.$`,
    ),
    ar: (m) =>
      `ترتيب تحديد نوع الفجوة. يُحدَّد نوع الفجوة وفق الترتيب الآتي: التوجيه الوارد في المنهجية، ثم تفاوت بين الفئات عند ظهور التنبيه، ثم فجوة حادة إذا بلغت شدة الاحتياج ${m[1]} أو أكثر، ثم فجوة مزمنة إذا بلغت الشدة ${m[2]} أو أكثر في الدورة الحالية والسابقة معًا، ثم فجوة هيكلية، ثم «غير مصنفة» إذا لم تُقَس الشدة. ويتطلب استنتاج أن الفجوة موسمية أكثر من دورة تقييم واحدة.`,
  },
];

/** The fixed Arabic for a Calculation Basis rule, or null for any other text. */
export function calculationBasisArabic(text: string): string | null {
  const trimmed = text.trim();
  for (const rule of RULES) {
    const m = trimmed.match(rule.match);
    if (m) return rule.ar(m);
  }
  return null;
}

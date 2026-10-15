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
      "مؤشر الاحتياجات = متوسط شدّة المجالات المقيسة. شدّة المجال هي متوسط مجالاته الفرعية المقيسة، والمجال الفرعي متوسط مؤشراته المقيسة، والمؤشر متوسط مؤشرات الأداء الرئيسية المقيسة، ومؤشر الأداء متوسط إجاباته المسجَّلة. تُتجاوز المستويات غير المقيسة في كل خطوة ولا تُحتسب صفرًا أبدًا.",
  },
  {
    match:
      /^Priority Score = Σ\(\(100 − domain severity\) × domain weight\) renormalised over the assessed domains' weight sum\. Performance-based, so LOWER means more urgent\.$/,
    ar: () =>
      "درجة الأولوية = مجموع ((100 − شدّة المجال) × وزن المجال)، مُعاد تطبيعه على مجموع أوزان المجالات المقيَّمة. تعتمد على الأداء، لذا فإن القيمة الأقل تعني إلحاحًا أعلى.",
  },
  {
    match: new RegExp(
      String.raw`^Severity 0–100 \(higher = worse\): ≥${N} CRITICAL, ≥${N} HIGH, ≥${N} MEDIUM, <${N} LOW\. A measured 0 is LOW; an unmeasured indicator is null and shown as '—'\.$`,
    ),
    ar: (m) =>
      `الشدّة من 0 إلى 100 (الأعلى = الأسوأ): ≥${m[1]} حرجة، ≥${m[2]} عالية، ≥${m[3]} متوسطة، <${m[4]} منخفضة. القيمة المقيسة 0 تُعدّ منخفضة، والمؤشر غير المقيس فارغ ويُعرض بالرمز «—».`,
  },
  {
    match: new RegExp(
      String.raw`^Confidence is LOW when valid responses < ${N} OR the don't-know rate > ${N}%; otherwise STANDARD\. The stated reason names only the condition that actually fired\.$`,
    ),
    ar: (m) =>
      `تكون الثقة منخفضة عندما يقل عدد الاستجابات الصالحة عن ${m[1]} أو تتجاوز نسبة «لا أعرف» ${m[2]}%، وإلا فهي قياسية. ويذكر السبب المبيَّن الشرط الذي تحقق فعلًا فقط.`,
  },
  {
    match: new RegExp(
      String.raw`^Equity flag fires when the severity spread \(max − min\) across a dimension's groups ≥ ${N} points AND every compared group has n ≥ ${N}\. When no dimension clears the group minimum the flag is false and the reason says the sample was too small — it is not a finding of no inequity\.$`,
    ),
    ar: (m) =>
      `يُفعَّل مؤشر الإنصاف عندما يبلغ تفاوت الشدّة (الأعلى − الأدنى) بين فئات أحد الأبعاد ${m[1]} نقطة أو أكثر، وكان عدد كل فئة مقارَنة ${m[2]} على الأقل. وإذا لم يستوفِ أي بُعد الحد الأدنى للفئات فلا يُفعَّل المؤشر، ويوضح السبب أن العينة صغيرة جدًا — وهذا لا يعني عدم وجود تفاوت.`,
  },
  // "ثم" (then) rather than arrows: the PDF renderer mirrors an arrow laid out
  // right to left, so "←" printed pointing back at the previous step.
  {
    match: new RegExp(
      String.raw`^gap_type precedence: methodology hint → inequality \(equity flag\) → acute \(severity ≥ ${N}\) → chronic \(severity ≥ ${N} in this AND the prior cycle\) → structural → not classified \(severity not measured\)\. "Seasonal" is never inferred from a single assessment cycle\.$`,
    ),
    ar: (m) =>
      `ترتيب تحديد نوع الفجوة: إرشاد المنهجية، ثم عدم المساواة (مؤشر الإنصاف)، ثم حادة (الشدّة ≥ ${m[1]})، ثم مزمنة (الشدّة ≥ ${m[2]} في هذه الدورة والدورة السابقة)، ثم هيكلية، ثم غير مصنفة (الشدّة غير مقيسة). ولا يُستنتج النوع «موسمي» أبدًا من دورة تقييم واحدة.`,
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

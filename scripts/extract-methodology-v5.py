#!/usr/bin/env python3
"""
extract-methodology-v5.py — RIO-AI-005 (legacy FR-19) methodology baseline extractor.

Reads the client's signed-off consolidated workbook and emits the machine-readable
v5.0 reference-data artifacts that `prisma/import-methodology.ts` imports.

    python scripts/extract-methodology-v5.py \
      --xlsx "../26-08-02 RIO_Basira_Consolidated_BRD_and_Methodology_V06 1.xlsx"

Outputs (into prisma/methodology/):
    question-bank-v5.json        193 questions + 9-domain / 44-sub-domain hierarchy + counts
    scoring-lookup-v5.json       option -> severity map, one row per lookup
    domain-priority-v5.csv       9-domain weights for import-domain-priority-config.ts
    verification-targets-v5.json the workbook's own worked-example outputs, for tests

This script is the ONLY place the .xlsx is parsed. Re-run it (never hand-edit the
artifacts) when a new methodology version is signed off, then bump --version-label.

WHY A SCRIPT AND NOT A ONE-OFF: RIO-AI-005's third acceptance criterion is that any
future methodology change goes through versioning/change control. That is only true if
the extraction is reproducible and diffable, so the artifacts are committed and this
script regenerates them byte-for-byte from the same workbook.
"""
import argparse
import collections
import json
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required:  pip install openpyxl")

Q_CODE = re.compile(r'^[A-Z]{3}-\d+$')

# ── Report Linkage values that mean "this question produces a severity score" ──
# Driving isScoreable off the workbook's own Report Linkage column (rather than
# guessing from answer type) is what makes the count come out at exactly the 166
# the workbook states, and it matches the 166 Q codes present on the
# KPI-Domain Rollup sheet. See the counts assertion at the bottom.
SCORING_LINKAGES = (
    'Village Scorecard',                 # 145 — the nine-domain index questions
    'Enriched KPI Rollup',               #  20 — feeder items enriching an anchor KPI
    'Vulnerability classification',      #   1 — XDM-08, scored but outside the index
)
# XDM-08 feeds the vulnerability classification and is excluded BY DESIGN from the
# nine-domain Village Development Needs Index (Change Summary v5.0, item 9).
INDEX_EXCLUDED_LINKAGE = 'Vulnerability classification'

# Answer types that are instrument scaffolding, not fielded questions. 193 - 7 = 186
# field items (Question Bank banner note).
NON_FIELDED_TYPES = {'Template pattern', 'Metadata module', 'Person-roster module'}

ON_HOLD = 'On hold — sensitivity protocol'

MANDATORY_MAP = {
    'Mandatory': 'required',
    'Conditional — mandatory when the condition applies': 'conditional',
    'Mandatory (per eligible person)': 'required_per_eligible_person',
    'Not fielded': 'not_fielded',
    ON_HOLD: 'on_hold',
}


def cells(ws):
    for row in ws.iter_rows(values_only=True):
        yield ['' if c is None else str(c).strip() for c in row]


def find_header(rows, first_col):
    for i, r in enumerate(rows):
        if r and r[0] == first_col:
            return i
    raise SystemExit(f'Could not find a header row starting with {first_col!r}')


def at(row, i):
    return row[i] if i < len(row) else ''


# ── Answer Type -> measurement mode + orthogonal flags ────────────────────────
def parse_answer_type(raw):
    """
    v5.0 uses 23 distinct Answer Type labels, but they are compositions of a base
    type plus modifiers. Per METH — Answer Type Defs: roster-qualified types are
    "scored exactly as the base type", and for compound types "the base type drives
    the severity score; the follow-up is captured as diagnostic detail". So the
    label is decomposed rather than enumerated.
    """
    roster_scope = None
    m = re.search(r'\(roster, per (person|child|woman|youth)\)', raw)
    if m:
        roster_scope = m.group(1)

    is_admin_record = '(administrative record)' in raw
    # "matrix", "multi-component" and "X + Y" are the three compound shapes.
    is_compound = bool(
        re.search(r'\bmatrix\b', raw) or 'multi-component' in raw or ' + ' in raw
    )

    base = re.sub(r'\s*\((?:roster, per \w+|administrative record|[^)]*)\)', '', raw).strip()
    base = re.sub(r'\s*\+.*$', '', base).strip()

    if base.startswith('Checklist matrix') or raw.startswith('Checklist matrix'):
        mode = 'CHECKLIST_MATRIX'
    elif base.startswith('Likert-5'):
        mode = 'LIKERT_5'
    elif base.startswith('Multi-select'):
        mode = 'MULTI_SELECT'
    elif base.startswith('Numeric'):
        mode = 'NUMERIC'
    elif base.startswith('Categorical') or base.startswith('Single-select'):
        mode = 'SINGLE_SELECT'
    elif raw == 'Template pattern':
        mode = 'TEMPLATE_PATTERN'
    elif raw == 'Metadata module':
        mode = 'METADATA_MODULE'
    elif raw == 'Person-roster module':
        mode = 'PERSON_ROSTER_MODULE'
    else:
        raise SystemExit(f'Unmapped Answer Type: {raw!r}')

    return mode, roster_scope, is_compound, is_admin_record


# ── Notes column -> former code, conditional rule, roster loop, gates ─────────
def parse_notes(note):
    """
    The Notes column carries four machine-readable facts in a `; `-separated list:
      "Former code: H10"                          -> the v1.0 -> v5.0 code map
      "Branch: asked only if HLT-08 = Yes"        -> a real branching condition
      "Skipped if WSH-01 = Piped into the dwelling"
      "Roster loop: each child aged 0-59 months"  -> roster iteration scope
      "Gates HLT-09"                              -> the reverse edge of a branch
    Anything not matching stays in `notes` verbatim — never silently dropped.
    """
    former_code = None
    rule = None
    roster_loop = None
    gates = []

    m = re.search(r'Former code:\s*([A-Za-z0-9\-]+)', note)
    if m:
        former_code = m.group(1)

    m = re.search(r'Roster loop:\s*([^;]+)', note)
    if m:
        roster_loop = m.group(1).strip()

    for g in re.finditer(r'Gates\s+([A-Z]{3}-\d+)', note):
        gates.append(g.group(1))

    # "asked only if <CODE> = <v1> / <v2> / ..."  |  "Skipped if <CODE> = <v>"
    m = re.search(r'(?:Branch:\s*)?asked only if\s+([A-Z]{3}-\d+)\s*=\s*([^;]+)', note, re.I)
    if m:
        rule = {
            'dependsOn': m.group(1),
            'operator': 'IN',
            'values': [v.strip() for v in m.group(2).split(' / ') if v.strip()],
        }
    else:
        m = re.search(r'Skipped if\s+([A-Z]{3}-\d+)\s*=\s*([^;]+)', note, re.I)
        if m:
            rule = {
                'dependsOn': m.group(1),
                'operator': 'NOT_IN',
                'values': [v.strip() for v in m.group(2).split(' / ') if v.strip()],
            }
        elif re.search(r'Asked (?:only )?(?:if|when)\s', note, re.I):
            # Prose-only condition ("Asked only if a birth occurred in the past 24
            # months") — real, but not expressible as a question-to-question rule.
            # Kept as an unstructured gate so it is visible rather than lost.
            mm = re.search(r'Asked (?:only )?(?:if|when)\s+([^;]+)', note, re.I)
            rule = {'dependsOn': None, 'operator': 'PROSE', 'description': mm.group(1).strip()}

    return former_code, rule, roster_loop, gates


def to_option_id(label):
    """Mirrors DeterministicScoringService.toOptionId / import-scoring-lookups.ts."""
    if not label:
        return ''
    return re.sub(r'^_+|_+$', '', re.sub(r'[^A-Z0-9]+', '_', label.upper().strip()))


COMPOSITE_SEP = '__'


def composite_option_id(label):
    """
    A ';'-joined option label is a COMPOSITE STATE, not one option: INF-14 scores
    "Ventilation; Roof; Walls" = 90 as a whole, per Change Summary v5.0 item 8
    ("Checklist items are scored on the composite state").

    The workbook enumerates the same set in several orders — "Ventilation; Roof;
    Walls" and "Ventilation; Walls; Roof" are both 90 — so the key has to be
    order-independent, or a citizen selecting the same three items in a different
    order would fail to resolve. Each part is normalized, then sorted, then joined
    with `__`. DeterministicScoringService.compositeOptionId builds the identical
    key from a submitted answer.
    """
    parts = sorted(to_option_id(p) for p in label.split(';') if p.strip())
    return COMPOSITE_SEP.join(parts)


def exclusion_reason(label):
    low = label.lower()
    if "don't know" in low or 'dont know' in low:
        return 'DONT_KNOW'
    if 'prefer not to answer' in low:
        return 'PREFER_NOT_TO_ANSWER'
    # Everything else is a genuine eligibility/applicability escape ("No school-age
    # children", "Not eligible", "No visit in the past 12 months", ...). These leave
    # the denominator but must NOT inflate the don't-know rate that drives the
    # confidence flag (methodology §Confidence flags).
    return 'NOT_APPLICABLE'


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)

    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', default=os.path.join(
        os.path.dirname(repo),
        '26-08-02 RIO_Basira_Consolidated_BRD_and_Methodology_V06 1.xlsx'))
    ap.add_argument('--out', default=os.path.join(repo, 'prisma', 'methodology'))
    ap.add_argument('--version-label', default='v5.0 - Approved methodology baseline')
    args = ap.parse_args()

    if not os.path.exists(args.xlsx):
        sys.exit(f'Workbook not found: {args.xlsx}')
    os.makedirs(args.out, exist_ok=True)

    wb = openpyxl.load_workbook(args.xlsx, data_only=True, read_only=True)

    # ══ 1. Question Bank ═════════════════════════════════════════════════════
    qb = list(cells(wb['METH — Question Bank']))
    h = find_header(qb, 'Q Code')
    header = qb[h]
    col = {name: i for i, name in enumerate(header)}
    required_cols = ['Q Code', 'Domain', 'Sub-Domain', 'Indicator', 'KPI', 'Question',
                     'Answer Type', 'Response Options', 'Analytical Category',
                     'Target Respondent', 'Mandatory / Optional', 'Used in MVP',
                     'Report Linkage', 'Notes']
    missing = [c for c in required_cols if c not in col]
    if missing:
        sys.exit(f'Question Bank is missing expected columns: {missing}')

    # ══ 2. Feeder -> anchor KPI map (20 items) from the KPI-Domain Rollup ════
    kr = list(cells(wb['METH — KPI-Domain Rollup']))
    kh = find_header(kr, 'Q Code')
    kcol = {name: i for i, name in enumerate(kr[kh])}
    feeds = {}
    rollup_codes = set()
    for r in kr[kh + 1:]:
        if r and Q_CODE.match(r[0]):
            rollup_codes.add(r[0])
            anchor = at(r, kcol['Feeds KPI (anchor code)'])
            if anchor and anchor != r[0]:
                feeds[r[0]] = anchor

    questions = []
    hierarchy = collections.OrderedDict()

    for r in qb[h + 1:]:
        if not r or not Q_CODE.match(r[0]):
            continue  # section banners ("Health — 26 items") and blank rows

        code = r[0]
        domain = at(r, col['Domain'])
        sub_domain = at(r, col['Sub-Domain'])
        indicator = at(r, col['Indicator'])
        kpi = at(r, col['KPI'])
        raw_type = at(r, col['Answer Type'])
        raw_options = at(r, col['Response Options'])
        mand_opt = at(r, col['Mandatory / Optional'])
        linkage = at(r, col['Report Linkage'])
        notes = at(r, col['Notes'])

        mode, roster_scope, is_compound, is_admin = parse_answer_type(raw_type)
        former_code, rule, roster_loop, gates = parse_notes(notes)

        is_fielded = raw_type not in NON_FIELDED_TYPES
        is_scoreable = linkage.startswith(SCORING_LINKAGES)
        excluded_from_index = linkage.startswith(INDEX_EXCLUDED_LINKAGE)
        on_hold = mand_opt == ON_HOLD

        # Response options: "A / B / C". Numeric items say "Open numeric (minutes)
        # / Don't know" — the free-numeric part is not an option, but the DK/NA
        # escapes that follow it are, and they carry real exclusion rows in the
        # Scoring Lookup, so they must survive.
        options = []
        if raw_options:
            for part in raw_options.split(' / '):
                p = part.strip()
                if not p or p.lower().startswith('open numeric'):
                    continue
                options.append(p)

        questions.append({
            'questionId': code,
            'formerCode': former_code,
            'domain': domain,
            'subDomain': sub_domain,
            'indicator': indicator if indicator and indicator != '—' else None,
            'kpi': kpi if kpi and kpi != '—' else None,
            'questionText': at(r, col['Question']),
            'answerTypeRaw': raw_type,
            'measurementMode': mode,
            'rosterScope': roster_scope,
            'isCompound': is_compound,
            'isAdminRecord': is_admin,
            'answerOptions': options or None,
            'analyticalCategory': at(r, col['Analytical Category']) or None,
            'targetRespondent': at(r, col['Target Respondent']) or None,
            'requiredOptional': MANDATORY_MAP.get(mand_opt, 'required'),
            'usedInMvp': at(r, col['Used in MVP']) == 'Yes',
            'reportMapping': linkage or None,
            'isFielded': is_fielded,
            'isScoreable': is_scoreable,
            'isHouseholdFielded': is_fielded and not is_admin and not on_hold,
            'excludedFromNineDomainIndex': excluded_from_index,
            'feedsKpiAnchor': feeds.get(code),
            'conditionalRule': rule,
            'rosterLoop': roster_loop,
            'gates': gates or None,
            'notes': notes or None,
        })

        # Hierarchy — the XDM cross-cutting pseudo-domain is NOT one of the nine
        # methodology Domains (same exclusion the v1.0 seed applied to "OPEN").
        if not domain.startswith('Cross-Domain'):
            hierarchy.setdefault(domain, collections.OrderedDict())
            hierarchy[domain].setdefault(sub_domain, None)

    # ══ 2b. Reconcile conditional-rule values against the parent's options ═══
    # The Notes column states branch conditions in prose, and the prose does not
    # always quote a literal option. EDU-05 reads "asked only if EDU-04 = Yes
    # (once or repeatedly)" while EDU-04's real options are
    # "No / Yes, once / Yes, repeatedly"; HLT-19 names "Outside a facility",
    # which is not one of HLT-18's options either.
    #
    # An IN rule whose values match nothing would make the scoring engine treat
    # the question as never applicable and silently drop every answer to it. So
    # each value is checked against the parent's own option set: matched values
    # are kept, unmatched ones are recorded, and a rule with NO match at all is
    # downgraded to PROSE (which the engine treats as "cannot evaluate, assume
    # applicable") rather than left as a condition that can never be true.
    by_code_tmp = {q['questionId']: q for q in questions}
    for q in questions:
        rule = q['conditionalRule']
        if not rule or rule.get('operator') not in ('IN', 'NOT_IN'):
            continue
        parent = by_code_tmp.get(rule['dependsOn'])
        parent_options = set(parent['answerOptions'] or []) if parent else set()
        if not parent_options:
            continue
        matched, unmatched = [], []
        for v in rule['values']:
            # Exact first, then a case-insensitive prefix match, which is what
            # links "Yes" to "Yes, once"/"Yes, repeatedly".
            if v in parent_options:
                matched.append(v)
                continue
            near = [o for o in parent_options if o.lower().startswith(v.lower().split(' (')[0])]
            if near:
                matched.extend(near)
            else:
                unmatched.append(v)
        if matched:
            rule['values'] = sorted(set(matched))
            if unmatched:
                rule['unmatchedValues'] = unmatched
        else:
            q['conditionalRule'] = {
                'dependsOn': rule['dependsOn'],
                'operator': 'PROSE',
                'description': f"{rule['dependsOn']} = {' / '.join(rule['values'])}",
                'unmatchedValues': rule['values'],
            }

    # ══ 3. Scoring Lookup ════════════════════════════════════════════════════
    sl = list(cells(wb['METH — Scoring Lookup']))
    sh = find_header(sl, 'Q Code')
    scol = {name: i for i, name in enumerate(sl[sh])}
    by_code = {q['questionId']: q for q in questions}

    lookups = []
    numeric_bounds = collections.defaultdict(dict)
    order_counter = collections.Counter()
    unknown_codes = set()

    for r in sl[sh + 1:]:
        if not r or not Q_CODE.match(r[0]):
            continue
        code = r[0]
        option_label = at(r, scol['Response Option'])
        raw_sev = at(r, scol['Severity Score (0-100)'])
        score_type = at(r, scol['Score Type'])

        q = by_code.get(code)
        if q is None:
            unknown_codes.add(code)
            continue

        # Numeric floor/ceiling: in v5.0 the BOUND VALUE is in the option label
        # ("Floor=0", "Ceiling=120") and the severity column holds the severity AT
        # that bound (0 or 100). Reading the severity column as the bound — which
        # the v1.0 importer did — silently inverts every reversed scale
        # (HLT-04 antenatal visits, HLT-07 growth visits, EDU-16 attendance days,
        # LIV-03 months of income) and zeroes INF-09's real floor of 2.
        if score_type in ('Numeric-Floor', 'Numeric-Ceiling'):
            m = re.search(r'=\s*(-?[\d.]+)', option_label)
            if not m:
                sys.exit(f'{code}: cannot parse a bound value from {option_label!r}')
            bound = float(m.group(1))
            sev = float(raw_sev) if raw_sev not in ('', '—') else None
            key = 'floor' if score_type == 'Numeric-Floor' else 'ceiling'
            numeric_bounds[code][key] = bound
            numeric_bounds[code][key + '_severity'] = sev
            continue

        if score_type == 'Diagnostic (unscored)':
            lookup_type, severity, excluded, reason = 'DIAGNOSTIC', None, False, None
        elif score_type == 'Excluded from denominator':
            lookup_type = {'LIKERT_5': 'LIKERT', 'MULTI_SELECT': 'MULTI_SELECT',
                           'CHECKLIST_MATRIX': 'CHECKLIST'}.get(q['measurementMode'], 'OPTION')
            severity, excluded, reason = None, True, exclusion_reason(option_label)
        elif score_type == 'Multi-select weight':
            lookup_type, excluded, reason = 'MULTI_SELECT', False, None
            severity = float(raw_sev) if raw_sev not in ('', '—') else None
        elif score_type == 'Standard':
            lookup_type = {'LIKERT_5': 'LIKERT', 'MULTI_SELECT': 'MULTI_SELECT',
                           'CHECKLIST_MATRIX': 'CHECKLIST'}.get(q['measurementMode'], 'OPTION')
            excluded, reason = False, None
            severity = float(raw_sev) if raw_sev not in ('', '—') else None
        else:
            sys.exit(f'{code}: unmapped Score Type {score_type!r}')

        is_composite = ';' in option_label
        option_id = composite_option_id(option_label) if is_composite else to_option_id(option_label)

        # Two orderings of the same composite set collapse onto one key. Same
        # severity => a harmless duplicate to drop; different severities would be
        # a genuine workbook inconsistency, so fail rather than pick one.
        if is_composite:
            prior = next((l for l in lookups
                          if l['questionId'] == code and l['optionId'] == option_id), None)
            if prior is not None:
                if prior['severityScore'] != (float(raw_sev) if raw_sev not in ('', '—') else None):
                    sys.exit(f'{code}: composite {option_id!r} has conflicting severities '
                             f'({prior["severityScore"]} vs {raw_sev}) — check the workbook')
                continue

        order_counter[code] += 1
        lookups.append({
            'questionId': code,
            'lookupType': lookup_type,
            'optionId': option_id,
            'optionLabel': option_label,
            'optionOrder': order_counter[code],
            'severityScore': severity,
            'numericFloor': None,
            'numericCeiling': None,
            'severityDirection': None,
            'isExcluded': excluded,
            'exclusionReason': reason,
            'isComposite': is_composite,
            'scoreTypeRaw': score_type,
        })

    # One merged NUMERIC row per numeric question, carrying both bounds + direction.
    for code, b in sorted(numeric_bounds.items()):
        if 'floor' not in b or 'ceiling' not in b:
            sys.exit(f'{code}: numeric lookup has only one bound: {b}')
        # Direction is derived, never guessed: severity 0 at the floor means a
        # higher raw value is worse; severity 100 at the floor means the scale is
        # reversed (more is better).
        direction = 'WORSENING_HIGHER' if b['floor_severity'] == 0 else 'WORSENING_LOWER'
        lookups.append({
            'questionId': code,
            'lookupType': 'NUMERIC',
            'optionId': None,
            'optionLabel': f"Floor={b['floor']} / Ceiling={b['ceiling']}",
            'optionOrder': 1,
            'severityScore': None,
            'numericFloor': b['floor'],
            'numericCeiling': b['ceiling'],
            'severityDirection': direction,
            'isExcluded': False,
            'exclusionReason': None,
            'isComposite': False,
            'scoreTypeRaw': 'Numeric-Floor+Ceiling',
        })

    # ══ 4. Verification targets (the workbook's own worked example) ═══════════
    pc = list(cells(wb['METH — Priority Classification']))
    ph = find_header(pc, 'Q Code')
    pcol = {name: i for i, name in enumerate(pc[ph])}
    tiers = collections.Counter()
    tiers_by_village = collections.defaultdict(collections.Counter)
    pc_rows = 0
    for r in pc[ph + 1:]:
        if not r or not Q_CODE.match(r[0]):
            continue
        pc_rows += 1
        tier = at(r, pcol['Priority Tier'])
        village = at(r, pcol['Village'])
        tiers[tier] += 1
        tiers_by_village[village][tier] += 1

    scorecard = {}
    for r in cells(wb['METH — Village Scorecard']):
        if len(r) >= 3 and r[0] in hierarchy and r[1]:
            try:
                scorecard[r[0]] = float(r[1])
            except ValueError:
                pass

    # ══ 5. Counts + self-check ═══════════════════════════════════════════════
    counts = {
        'totalQuestions': len(questions),
        'fieldItems': sum(1 for q in questions if q['isFielded']),
        'severityScoredItems': sum(1 for q in questions if q['isScoreable']),
        'householdFieldedItems': sum(1 for q in questions if q['isHouseholdFielded']),
        'domains': len(hierarchy),
        'subDomains': sum(len(v) for v in hierarchy.values()),
        'indicators': len({q['indicator'] for q in questions if q['indicator']}),
        'kpis': len({q['kpi'] for q in questions if q['kpi']}),
        'feederItems': sum(1 for q in questions if q['feedsKpiAnchor']),
        'diagnosticItems': sum(1 for q in questions
                               if not q['isScoreable'] and q['isFielded']
                               and q['reportMapping']
                               and 'does not enter the scores' in q['reportMapping']),
        'scoringLookupRows': len(lookups),
        'scoringLookupQuestions': len({l['questionId'] for l in lookups}),
        'numericQuestions': len(numeric_bounds),
        'reversedNumericQuestions': sum(
            1 for l in lookups if l['severityDirection'] == 'WORSENING_LOWER'),
        'conditionalRules': sum(1 for q in questions if q['conditionalRule']),
        'rosterLoops': sum(1 for q in questions if q['rosterLoop']),
        'formerCodesMapped': sum(1 for q in questions if q['formerCode']),
    }

    # These are the workbook's own stated figures. A mismatch means the extractor
    # and the signed-off methodology have diverged — fail loudly, never import.
    expected = {
        'totalQuestions': 193, 'fieldItems': 186, 'severityScoredItems': 166,
        'householdFieldedItems': 184, 'domains': 9, 'subDomains': 44,
        'indicators': 172, 'feederItems': 20, 'diagnosticItems': 18,
    }
    problems = [f'  {k}: expected {v}, extracted {counts[k]}'
                for k, v in expected.items() if counts[k] != v]
    if unknown_codes:
        problems.append(f'  Scoring Lookup references unknown Q codes: {sorted(unknown_codes)}')
    if counts['severityScoredItems'] != len(rollup_codes):
        problems.append(f"  scoreable ({counts['severityScoredItems']}) != KPI-Rollup "
                        f'Q codes ({len(rollup_codes)})')
    missing_lookups = sorted(
        q['questionId'] for q in questions
        if q['isScoreable'] and q['questionId'] not in {l['questionId'] for l in lookups})
    if missing_lookups:
        problems.append(f'  scoreable questions with NO scoring lookup: {missing_lookups}')

    if problems:
        print('EXTRACTION FAILED — workbook counts do not reconcile:', file=sys.stderr)
        print('\n'.join(problems), file=sys.stderr)
        sys.exit(1)

    # ══ 6. Write artifacts ═══════════════════════════════════════════════════
    bank = {
        '_meta': {
            'title': 'RIO methodology reference data — Village Needs Methodology v5.0',
            'versionLabel': args.version_label,
            'extractedFrom': os.path.basename(args.xlsx),
            'extractedBy': 'scripts/extract-methodology-v5.py',
            'requirement': 'RIO-AI-005 (legacy FR-19) — approved methodology implementation baseline',
            'signOff': 'Dr. Zulfiqar, July 2026 (METH — Change Summary v5.0)',
            'counts': counts,
            'countNote': (
                '193 = the full instrument. 186 = field items (193 minus the 7 '
                'questionnaire-structure/roster/template modules XDM-01..07). '
                '184 = questions actually fielded to households (186 minus WSH-15, '
                'answered from an administrative record, and SOC-08, on hold under '
                'the sensitivity protocol). 166 = items carrying a severity score. '
                'These describe the same bank at different scopes.'
            ),
        },
        'hierarchy': [
            {'name': d, 'subDomains': list(subs.keys())} for d, subs in hierarchy.items()
        ],
        'questions': questions,
    }

    out = {
        'question-bank-v5.json': bank,
        'scoring-lookup-v5.json': {
            '_meta': {
                'versionLabel': args.version_label,
                'extractedFrom': os.path.basename(args.xlsx),
                'sheet': 'METH — Scoring Lookup',
                'rows': len(lookups),
                'questions': counts['scoringLookupQuestions'],
                'note': (
                    'NUMERIC rows are merged: one row per question carrying floor, '
                    'ceiling and a derived severityDirection. The bound VALUE comes '
                    'from the option label ("Floor=0"/"Ceiling=120"); the severity '
                    'column holds the severity AT that bound, which is what makes '
                    'the direction derivable.'
                ),
            },
            'lookups': lookups,
        },
        'verification-targets-v5.json': {
            '_meta': {
                'versionLabel': args.version_label,
                'purpose': (
                    "The workbook's own worked example (3 villages / 75 households / "
                    '13,800 synthetic rows). Reproducing these numbers is the only '
                    'real proof the baseline is configured correctly — RIO-AI-005 '
                    'acceptance criterion 1.'
                ),
            },
            'counts': counts,
            'priorityClassification': {
                'rows': pc_rows,
                'villages': sorted(tiers_by_village.keys()),
                'tierTotals': dict(tiers),
                'tiersByVillage': {v: dict(c) for v, c in tiers_by_village.items()},
            },
            'villageScorecardAlJumumNorth': scorecard,
        },
    }
    for name, payload in out.items():
        p = os.path.join(args.out, name)
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'  wrote {name}')

    # Domain priority weights — see the header comment in the CSV itself.
    n = len(hierarchy)
    base = round(1.0 / n, 5)
    weights = [base] * n
    weights[-1] = round(1.0 - base * (n - 1), 5)  # absorb the rounding remainder
    critical = {'Health', 'Water & Sanitation'}
    csv_path = os.path.join(args.out, 'domain-priority-v5.csv')
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        f.write('domainKey,domainNameSnapshot,weight,isCriticalDomain,criticalPerformanceThreshold\n')
        for (d, _), w in zip(hierarchy.items(), weights):
            key = re.sub(r'^_+|_+$', '', re.sub(r'[^A-Z0-9]+', '_', d.upper()))
            is_crit = d in critical
            f.write(f'{key},{d},{w:.5f},{str(is_crit).lower()},{20 if is_crit else 30}\n')
    print(f'  wrote domain-priority-v5.csv ({n} domains, weights sum '
          f'{sum(weights):.5f})')

    print('\nCounts reconciled against the workbook:')
    for k, v in counts.items():
        mark = ' <= workbook figure' if k in expected else ''
        print(f'  {k:28s} {v}{mark}')


if __name__ == '__main__':
    main()

import { readFileSync } from 'node:fs';

/**
 * RIO-NFR-015 — the traceability matrix (docs/traceability-matrix.md) went
 * six weeks without review earlier this project. This check exists to catch
 * that drift early instead of after the fact.
 *
 * Deliberately does NOT use `git log` on the file's own history: CI checks
 * out a shallow clone (fetch-depth 1 by default), which usually has no real
 * history for an arbitrary path — a git-log-based version of this check
 * would silently no-op almost every run, which is worse than not having it.
 *
 * Instead, this reads a single, deliberately plain marker line at the top of
 * the matrix file — `**Freshness check date:** YYYY-MM-DD` — and compares it
 * to today. That line has to be updated by hand whenever someone actually
 * reviews the matrix, which is the whole point: it is a real, human
 * attestation of "someone looked at this on this date," not a proxy for code
 * activity.
 */

const WARN_AFTER_DAYS = 30;
const MATRIX_PATH = 'docs/traceability-matrix.md';
const MARKER_PATTERN = /\*\*Freshness check date:\*\*\s*(\d{4}-\d{2}-\d{2})/;

function main(): void {
  let content: string;
  try {
    content = readFileSync(MATRIX_PATH, 'utf8');
  } catch {
    console.warn(`[traceability-freshness] Could not read ${MATRIX_PATH} — skipping.`);
    return;
  }

  const match = MARKER_PATTERN.exec(content);
  if (!match) {
    console.warn(
      `[traceability-freshness] WARNING: no "**Freshness check date:** YYYY-MM-DD" marker found in ${MATRIX_PATH}. ` +
        `Add one so this check has something to compare against. Informational only; does not fail the build.`,
    );
    return;
  }

  const markerDate = new Date(match[1]);
  if (Number.isNaN(markerDate.getTime())) {
    console.warn(`[traceability-freshness] WARNING: marker date "${match[1]}" is not a valid date.`);
    return;
  }

  const daysSince = Math.round((Date.now() - markerDate.getTime()) / (1000 * 60 * 60 * 24));

  if (daysSince > WARN_AFTER_DAYS) {
    console.warn(
      `[traceability-freshness] WARNING: the matrix was last marked reviewed ${daysSince} day(s) ago ` +
        `(${match[1]}), more than the ${WARN_AFTER_DAYS}-day freshness window. ` +
        `This is the same drift pattern that let it go six weeks unreviewed before — worth a look. ` +
        `Informational only; does not fail the build.`,
    );
  } else {
    console.log(`[traceability-freshness] OK — last marked reviewed ${daysSince} day(s) ago (${match[1]}).`);
  }
}

main();

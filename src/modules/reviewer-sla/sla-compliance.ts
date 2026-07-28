import type { SlaAlert } from "./reviewer-sla.types";

/** Compliance figures derived from the open reviewer-SLA queue.
 *  Shared so the Collective Dashboard screen and the RPT02 export can never
 *  drift apart — both read this one definition. */
export interface SlaCompliance {
  slaCompliancePct: number | null;
  breached: number;
  atRisk: number;
}

// Approximate compliance from the open reviewer-SLA queue: the share not
// breached. Null (rather than 100) on an empty queue — "nothing to measure"
// is not the same as "perfect".
// TODO(reviewer-sla): replace with a completed-within-SLA metric over a
// reporting period once ReviewerSlaService exposes one.
export function slaComplianceFromAlerts(alerts: SlaAlert[]): SlaCompliance {
  const breached = alerts.filter((a) => a.status === "breached").length;
  const atRisk = alerts.filter((a) => a.status === "at_risk").length;
  const total = alerts.length;
  return {
    slaCompliancePct: total === 0 ? null : Math.round(((total - breached) / total) * 100),
    breached,
    atRisk,
  };
}

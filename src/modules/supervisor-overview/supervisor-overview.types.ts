export interface SupervisorOverviewRow {
  organizationId: string;
  organizationName: string;
  activeStudyTitle: string | null;
  latestReportTitle: string | null;
  sharingStatus: "pending" | "approved" | "rejected" | "expired" | null;
  lastActivity: string;
}

export interface SupervisorOverview {
  totalOrganizations: number;
  studiesInProgress: number;
  reportsShared: number;
  pendingSharingRequests: number;
  rows: SupervisorOverviewRow[];
}

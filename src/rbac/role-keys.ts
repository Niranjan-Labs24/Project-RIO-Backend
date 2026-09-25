/** The role keys the code branches on. Compare against these, never a bare string literal. */
export const ROLE_KEYS = {
  systemAdmin: 'system_admin',
  systemReviewer: 'system_reviewer',
  centerSupervisor: 'center_supervisor',
  humanReviewer: 'human_reviewer',
} as const;

import { registerSchema, T } from '../../contract/typebox';

// Response schema (GAP-08 Phase 0) — GET /roles returns RoleDef[]
// (RolesController#list -> ROLE_MATRIX, see ../../rbac/role-matrix.ts).
// Shape sourced from the frontend's own documented mirror of this response
// (Project-RIO-Frontend/src/services/roles/roles.service.ts's `ApiRole`
// interface) and verified field-for-field identical to the backend's own
// RoleDef/ModulePermission types (rbac/role-matrix.ts) — no discrepancies
// found. `module`/`PermissionModule` is a fixed, closed set of 16 string
// literals (see PERMISSION_MODULES in role-matrix.ts) — modeled here as a
// literal union rather than a free string so the generated frontend type
// stays exact.
const PermissionModuleEnum = T.Union([
  T.Literal('entityTeam'),
  T.Literal('rolesPermissions'),
  T.Literal('onboardingConsent'),
  T.Literal('methodologyQuestionBank'),
  T.Literal('studySurvey'),
  T.Literal('dataCollection'),
  T.Literal('dataImport'),
  T.Literal('citizenChannel'),
  T.Literal('aiReview'),
  T.Literal('priorityScoring'),
  T.Literal('reportsDashboards'),
  T.Literal('archiveSharingAudit'),
  T.Literal('surveyBuilder'),
  T.Literal('ncnpReport'),
  T.Literal('systemLogs'),
  T.Literal('auditLog'),
]);

const ModulePermission = registerSchema(
  'ModulePermission',
  T.Object({
    module: PermissionModuleEnum,
    read: T.Boolean(),
    write: T.Boolean(),
    create: T.Boolean(),
    approve: T.Boolean(),
    export: T.Boolean(),
    share: T.Boolean(),
  }),
);

export const RoleDef = registerSchema(
  'RoleDef',
  T.Object({
    id: T.String(),
    key: T.String(),
    name: T.String(),
    description: T.String(),
    crossEntity: T.Boolean(),
    permissions: T.Array(ModulePermission),
  }),
);

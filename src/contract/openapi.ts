import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as swaggerUi from 'swagger-ui-express';
import { getRegisteredSchemas } from './typebox';

type Tag =
  | 'Auth'
  | 'Consent'
  | 'Users'
  | 'Organizations'
  | 'Roles'
  | 'Studies'
  | 'Needs'
  | 'Evidence'
  | 'AI Decisions'
  | 'Audit'
  | 'Health';

interface RouteDoc {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: Tag;
  summary: string;
  /** `undefined` = public (no session required). `'session'` = any signed-in
   * user (enforced by requireActor() inside the service, not a route
   * decorator). Otherwise the exact `@RequirePermission(module, action)` on
   * the route. */
  auth: undefined | 'session' | { module: string; action: string };
  requestSchema?: string;
  query?: string[];
  response: string;
}

// One entry per tag, in the order they should appear in Swagger UI's
// sidebar — otherwise it falls back to alphabetical, which buries Auth.
const TAGS: Array<{ name: Tag; description: string }> = [
  { name: 'Auth', description: 'Signup, login, session, and password/consent for the calling user.' },
  { name: 'Consent', description: 'The active data-sharing consent policy shown before signup.' },
  { name: 'Studies', description: 'RIO-FR-001 — the container for a captured community need.' },
  { name: 'Needs', description: 'RIO-FR-001 — the one need captured per study.' },
  { name: 'Evidence', description: 'RIO-FR-Add-01 — supporting documents uploaded against a study.' },
  { name: 'AI Decisions', description: 'RIO-FR-003 — classification/scoring placeholders and human review.' },
  { name: 'Users', description: "Manage the caller's own organisation's members." },
  { name: 'Organizations', description: "The caller's own organisation profile, plus cross-entity org listing." },
  { name: 'Roles', description: 'The fixed 9-role permission matrix.' },
  { name: 'Audit', description: 'Immutable audit log of every write across the app.' },
  { name: 'Health', description: 'Liveness/readiness probes.' },
];

// Hand-maintained to mirror each controller exactly — there are ~25 routes
// total, small enough that duplicating them here (rather than reflecting
// Nest's route metadata at runtime) stays easy to keep in sync. When you add
// or change a route in a *.controller.ts file, add/update its entry here too.
const ROUTES: RouteDoc[] = [
  {
    method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Sign in with email + password',
    auth: undefined, response: 'SessionContext',
  },
  {
    method: 'post', path: '/auth/signup', tag: 'Auth', summary: 'Public NGO signup — creates the organisation + its first NGO Admin',
    auth: undefined, requestSchema: 'SignupBody', response: 'SignupResponseView (SessionContext + temporaryPasswordEmailed)',
  },
  {
    method: 'get', path: '/auth/me', tag: 'Auth', summary: "Re-fetch the caller's current session",
    auth: 'session', response: 'SessionContext',
  },
  {
    method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Sign out (clears the session/CSRF cookies)',
    auth: 'session', response: '204 No Content',
  },
  {
    method: 'post', path: '/auth/consent', tag: 'Auth', summary: 'Record the consent-policy acceptance for the current user',
    auth: 'session', response: '{ consentedAt, policyVersion }',
  },
  {
    method: 'post', path: '/auth/change-password', tag: 'Auth', summary: "Replace the caller's own password",
    auth: 'session', requestSchema: 'ChangePasswordBody', response: 'SessionContext',
  },
  {
    method: 'get', path: '/consent-policy/active', tag: 'Consent', summary: 'The currently active data-sharing consent policy (version + text)',
    auth: undefined, response: 'ActiveConsentPolicy',
  },
  {
    method: 'post', path: '/studies', tag: 'Studies', summary: 'Create a study',
    auth: { module: 'studySurvey', action: 'create' }, requestSchema: 'CreateStudyBody', response: 'Study',
  },
  {
    method: 'get', path: '/studies', tag: 'Studies', summary: "List the caller's organisation's studies",
    auth: { module: 'studySurvey', action: 'read' }, query: ['limit', 'offset', 'status', 'search'],
    response: 'StudyListResult ({ items: Study[], total, limit, offset })',
  },
  {
    method: 'get', path: '/studies/{id}', tag: 'Studies', summary: 'Get a single study',
    auth: { module: 'studySurvey', action: 'read' }, response: 'StudyDetail (Study + evidenceCount)',
  },
  {
    method: 'patch', path: '/studies/{id}', tag: 'Studies', summary: "Rename a study (title is the only editable Study-level field)",
    auth: { module: 'studySurvey', action: 'write' }, requestSchema: 'UpdateStudyBody', response: 'Study',
  },
  {
    method: 'delete', path: '/studies/{id}', tag: 'Studies', summary: 'Delete a study — allowed only up to evidence_submitted; blocked once ai_classified/human_reviewed',
    auth: { module: 'studySurvey', action: 'write' }, response: '204 No Content',
  },
  {
    method: 'post', path: '/studies/{studyId}/need', tag: 'Needs', summary: 'Capture the need for a study (one per study)',
    auth: { module: 'dataCollection', action: 'create' }, requestSchema: 'CreateNeedBody', response: 'Need',
  },
  {
    method: 'get', path: '/studies/{studyId}/need', tag: 'Needs', summary: "Get a study's captured need",
    auth: { module: 'dataCollection', action: 'read' }, response: 'Need',
  },
  {
    method: 'patch', path: '/studies/{studyId}/need', tag: 'Needs', summary: "Edit a study's captured need",
    auth: { module: 'dataCollection', action: 'write' }, requestSchema: 'UpdateNeedBody', response: 'Need',
  },
  {
    method: 'post', path: '/studies/{studyId}/evidence', tag: 'Evidence', summary: 'Upload one or more evidence files (multipart/form-data, field name "files"; max 10MB/file, 10 files/study)',
    auth: { module: 'dataCollection', action: 'create' }, response: 'Evidence[]',
  },
  {
    method: 'get', path: '/studies/{studyId}/evidence', tag: 'Evidence', summary: "List a study's uploaded evidence",
    auth: { module: 'dataCollection', action: 'read' }, response: 'Evidence[]',
  },
  {
    method: 'post', path: '/studies/{studyId}/evidence/submit', tag: 'Evidence', summary: 'Submit uploaded evidence — required before AI Classification is allowed to run',
    auth: { module: 'dataCollection', action: 'write' }, response: '200 OK',
  },
  {
    method: 'delete', path: '/evidence/{id}', tag: 'Evidence', summary: 'Delete an uploaded evidence file',
    auth: { module: 'dataCollection', action: 'write' }, response: '204 No Content',
  },
  {
    method: 'post', path: '/studies/{studyId}/ai-decisions/classify', tag: 'AI Decisions', summary: 'Run the (placeholder) need classification and store the AI suggestion (domains[]/subDomains[] — one Need, possibly several suggested domains). Requires evidence to have been submitted first.',
    auth: { module: 'aiReview', action: 'write' }, response: 'AiDecision',
  },
  {
    method: 'get', path: '/studies/{studyId}/ai-decisions', tag: 'AI Decisions', summary: "List a study's AI decisions",
    auth: { module: 'aiReview', action: 'read' }, response: 'AiDecision[]',
  },
  {
    method: 'post', path: '/studies/{studyId}/ai-decisions/score', tag: 'AI Decisions', summary: 'Priority scoring stub — no DB write; scoring engine lands once methodology is approved',
    auth: { module: 'priorityScoring', action: 'create' }, response: '{ status: "pending", message: string }',
  },
  {
    method: 'patch', path: '/ai-decisions/{id}/review', tag: 'AI Decisions', summary: "Record a human reviewer's decision over an AI suggestion",
    auth: { module: 'aiReview', action: 'approve' }, requestSchema: 'ReviewDecisionBody', response: 'AiDecision',
  },
  {
    method: 'get', path: '/users', tag: 'Users', summary: "List the caller's own organisation's users, or (cross-entity) another org's via ?organizationId",
    auth: { module: 'entityTeam', action: 'read' }, query: ['organizationId', 'limit', 'offset'], response: 'OrgUser[]',
  },
  {
    method: 'post', path: '/users', tag: 'Users', summary: 'Invite a user into the caller\'s own organisation',
    auth: { module: 'entityTeam', action: 'create' }, requestSchema: 'InviteUserBody', response: 'OrgUser',
  },
  {
    method: 'patch', path: '/users/{id}', tag: 'Users', summary: "Update a user in the caller's own organisation",
    auth: { module: 'entityTeam', action: 'write' }, requestSchema: 'UpdateUserBody', response: 'OrgUser',
  },
  {
    method: 'delete', path: '/users/{id}', tag: 'Users', summary: "Remove a user from the caller's own organisation",
    auth: { module: 'entityTeam', action: 'write' }, response: '204 No Content',
  },
  {
    method: 'get', path: '/organizations/current', tag: 'Organizations', summary: "The caller's own organisation profile",
    auth: { module: 'entityTeam', action: 'read' }, response: 'Organization',
  },
  {
    method: 'patch', path: '/organizations/current', tag: 'Organizations', summary: "Update the caller's own organisation profile",
    auth: { module: 'entityTeam', action: 'write' }, requestSchema: 'UpdateOrganizationBody', response: 'Organization',
  },
  {
    method: 'get', path: '/organizations', tag: 'Organizations', summary: 'Cross-entity — every organisation on the platform',
    auth: { module: 'entityTeam', action: 'read' }, query: ['limit', 'offset'], response: 'OrganizationSummary[]',
  },
  {
    method: 'get', path: '/organizations/{id}', tag: 'Organizations', summary: "Cross-entity — another organisation's profile",
    auth: { module: 'entityTeam', action: 'read' }, response: 'OrganizationSummary',
  },
  {
    method: 'post', path: '/organizations', tag: 'Organizations', summary: 'Create a new organisation + its first NGO Admin',
    auth: { module: 'entityTeam', action: 'create' }, requestSchema: 'CreateOrganizationBody', response: 'Organization',
  },
  {
    method: 'get', path: '/roles', tag: 'Roles', summary: 'List the fixed 9-role permission matrix',
    auth: { module: 'rolesPermissions', action: 'read' }, response: 'RoleDef[]',
  },
  {
    method: 'get', path: '/audit', tag: 'Audit', summary: 'Immutable audit log — own organisation, or (cross-entity) any organisation via ?organizationId',
    auth: { module: 'archiveSharingAudit', action: 'read' },
    query: ['organizationId', 'entityType', 'entityId', 'actorId', 'action', 'dateFrom', 'dateTo', 'search', 'limit', 'offset'],
    response: '{ items: AuditEvent[], total, limit, offset }',
  },
  {
    method: 'get', path: '/health', tag: 'Health', summary: 'Liveness probe',
    auth: undefined, response: '{ status: "ok" }',
  },
  {
    method: 'get', path: '/health/db', tag: 'Health', summary: 'Readiness probe — confirms the database is reachable',
    auth: undefined, response: '{ status: "ok" } | 503',
  },
];

function toOpenApiPath(path: string): string {
  // {id} is already OpenAPI's placeholder syntax — no conversion needed,
  // just prefix with the app's global prefix (see main.ts's setGlobalPrefix).
  return `/api${path}`;
}

function buildOperation(route: RouteDoc): Record<string, unknown> {
  const description =
    route.auth === undefined
      ? 'No authentication required.'
      : route.auth === 'session'
        ? 'Requires a signed-in session.'
        : `Requires ${route.auth.module}:${route.auth.action}.`;

  const parameters = (route.query ?? []).map((name) => ({
    name,
    in: 'query',
    required: false,
    schema: { type: 'string' },
  }));

  // Every {name} placeholder in the path needs a matching path parameter,
  // not just {id} — routes like /studies/{studyId}/need have their own.
  const pathParamNames = [...route.path.matchAll(/{([^}]+)}/g)].map((m) => m[1]);
  const pathParams = pathParamNames.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

  return {
    tags: [route.tag],
    summary: route.summary,
    description,
    ...(pathParams.length + parameters.length > 0
      ? { parameters: [...pathParams, ...parameters] }
      : {}),
    ...(route.requestSchema
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.requestSchema}` } } },
          },
        }
      : {}),
    responses: {
      '200': { description: route.response },
    },
    ...(route.auth && route.auth !== 'session' ? { 'x-required-permission': route.auth } : {}),
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const key = toOpenApiPath(route.path);
    paths[key] = { ...(paths[key] ?? {}), [route.method]: buildOperation(route) };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'cnap-api',
      version: '0.1.0',
      description:
        'Session is a bearer token or the rio_session httpOnly cookie. Routes ' +
        'marked with a required permission additionally need the caller\'s ' +
        'role to have that module/action grant (see RBAC role-matrix.ts).',
    },
    tags: TAGS,
    paths,
    components: { schemas: getRegisteredSchemas() },
  };
}

export function setupOpenApi(app: INestApplication): void {
  const doc = buildOpenApiDocument();
  const http = app.getHttpAdapter().getInstance();
  http.get('/openapi.json', (_req: Request, res: Response) => res.json(doc));
  http.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
}

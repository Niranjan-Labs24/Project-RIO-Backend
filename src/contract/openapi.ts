import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as swaggerUi from 'swagger-ui-express';
import { getRegisteredSchemas } from './typebox';

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'cnap-api', version: '0.1.0' },
    paths: {
      '/api/roles': {
        get: {
          summary: 'List the fixed role/permission matrix (rolesPermissions:read)',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: { schemas: getRegisteredSchemas() },
  };
}

export function setupOpenApi(app: INestApplication): void {
  const doc = buildOpenApiDocument();
  const http = app.getHttpAdapter().getInstance();
  http.get('/openapi.json', (_req: Request, res: Response) => res.json(doc));
  http.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
}

import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as swaggerUi from 'swagger-ui-express';
import { getRegisteredSchemas } from './typebox';

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'cnap-api', version: '0.1.0' },
    paths: {
      '/notes': {
        get: {
          summary: 'List notes for the caller org',
          responses: { '200': { description: 'OK' } },
        },
        post: {
          summary: 'Create a note in the caller org',
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateNoteBody' },
              },
            },
          },
          responses: { '201': { description: 'Created' } },
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

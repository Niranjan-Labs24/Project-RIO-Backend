import type { Params } from 'nestjs-pino';
import { getOrgStore } from '../../tenancy/org-context';

export function buildLoggerConfig(level: string): Params {
  return {
    pinoHttp: {
      level,
      // Attach correlation + tenant context; never log request bodies (PII risk).
      customProps: () => {
        const store = getOrgStore();
        return { requestId: store?.requestId, orgId: store?.orgId };
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-org-id"]'],
        remove: true,
      },
      autoLogging: true,
      serializers: {
        req: (req: { id: unknown; method: unknown; url: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
      },
    },
  };
}

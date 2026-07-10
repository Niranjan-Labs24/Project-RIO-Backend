import { OrgContextMiddleware } from './org-context.middleware';
import { getOrgStore } from './org-context';
import type { ConfigService } from '../config/config.service';

function makeFakeConfig(nodeEnv: 'development' | 'test' | 'production'): ConfigService {
  return { nodeEnv } as ConfigService;
}

function makeFakeReq(headers: Record<string, string>) {
  return { headers } as never;
}

function makeFakeRes() {
  return { setHeader: () => undefined } as never;
}

describe('OrgContextMiddleware', () => {
  it('ignores x-org-id in production (fails closed) but still sets requestId', () => {
    const middleware = new OrgContextMiddleware(makeFakeConfig('production'));
    const req = makeFakeReq({ 'x-org-id': 'org-x' });
    const res = makeFakeRes();

    let orgId: string | undefined;
    let requestId: string | undefined;
    middleware.use(req, res, () => {
      const store = getOrgStore();
      orgId = store?.orgId;
      requestId = store?.requestId;
    });

    expect(orgId).toBeUndefined();
    expect(requestId).toBeDefined();
  });

  it('honors x-org-id outside production', () => {
    const middleware = new OrgContextMiddleware(makeFakeConfig('development'));
    const req = makeFakeReq({ 'x-org-id': 'org-x' });
    const res = makeFakeRes();

    let orgId: string | undefined;
    middleware.use(req, res, () => {
      orgId = getOrgStore()?.orgId;
    });

    expect(orgId).toBe('org-x');
  });
});

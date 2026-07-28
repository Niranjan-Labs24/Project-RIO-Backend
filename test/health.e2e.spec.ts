import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { HealthController } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

async function buildApp(prismaMock: unknown, redisMock: unknown): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: PrismaService, useValue: prismaMock },
      { provide: RedisService, useValue: redisMock },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('Health (e2e)', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp(
      { $queryRaw: () => Promise.resolve([{ ok: 1 }]) },
      { ping: () => Promise.resolve(true) },
    );
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
    await app.close();
  });

  it('GET /health/db returns ok when the DB responds', async () => {
    const app = await buildApp(
      { $queryRaw: () => Promise.resolve([{ ok: 1 }]) },
      { ping: () => Promise.resolve(true) },
    );
    await request(app.getHttpServer()).get('/health/db').expect(200, { status: 'ok' });
    await app.close();
  });

  it('GET /health/db returns a stable error code, never the raw exception message', async () => {
    const app = await buildApp(
      { $queryRaw: () => Promise.reject(new Error('password authentication failed for user "cnap_app" at host 10.0.4.12')) },
      { ping: () => Promise.resolve(true) },
    );
    const res = await request(app.getHttpServer()).get('/health/db').expect(503);
    expect(res.body.error.code).toBe('DB_UNAVAILABLE');
    expect(res.body.error.message).toBe('Database is currently unavailable');
    expect(JSON.stringify(res.body)).not.toContain('10.0.4.12');
    expect(JSON.stringify(res.body)).not.toContain('cnap_app');
    await app.close();
  });

  it('GET /health/redis returns ok when Redis responds', async () => {
    const app = await buildApp(
      { $queryRaw: () => Promise.resolve([{ ok: 1 }]) },
      { ping: () => Promise.resolve(true) },
    );
    await request(app.getHttpServer()).get('/health/redis').expect(200, { status: 'ok' });
    await app.close();
  });

  it('GET /health/redis returns REDIS_UNAVAILABLE when Redis is down, without leaking detail', async () => {
    const app = await buildApp(
      { $queryRaw: () => Promise.resolve([{ ok: 1 }]) },
      { ping: () => Promise.resolve(false) },
    );
    const res = await request(app.getHttpServer()).get('/health/redis').expect(503);
    expect(res.body.error.code).toBe('REDIS_UNAVAILABLE');
    await app.close();
  });
});

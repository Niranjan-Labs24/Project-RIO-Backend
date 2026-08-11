import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { ConfigService } from '../../config/config.service';
import { SystemLogsService } from '../../modules/system-logs/system-logs.service';

/**
 * RIO-NFR-016 — records the outcome of *successful* requests into
 * system_logs.
 *
 * Errors are deliberately not handled here. AllExceptionsFilter records
 * every 4xx and 5xx instead, because it is the only place that sees all of
 * them: guards run before interceptors, so a 401 from JwtAuthGuard or a 403
 * from PermissionGuard never reaches this class. Splitting the two would
 * either miss those or double-count everything else.
 *
 * What is left, then, is the success path:
 *
 * - **Slow 2xx** — recorded as `warn` with `HTTP_SLOW`. The one case where a
 *   successful request is still an operational event worth keeping.
 * - **Ordinary 2xx** — sampled at SYSTEM_LOG_SAMPLE_RATE, which defaults to
 *   0. Persisting every successful request would add millions of rows a
 *   month for no diagnostic value; stdout still has them all.
 */
@Injectable()
export class OperationalLogInterceptor implements NestInterceptor {
  constructor(
    private readonly logs: SystemLogsService,
    private readonly config: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.recordSuccess(req, http.getResponse<Response>(), startedAt),
      }),
    );
  }

  private recordSuccess(req: Request, res: Response, startedAt: number): void {
    try {
      const durationMs = Date.now() - startedAt;
      const slow = durationMs >= this.config.systemLogSlowRequestMs;
      if (!slow && Math.random() >= this.config.systemLogSampleRate) return;

      const statusCode = res.statusCode;
      const path = routePath(req);
      this.logs.record({
        level: slow ? 'warn' : 'info',
        category: 'http',
        source: OperationalLogInterceptor.name,
        eventCode: slow ? 'HTTP_SLOW' : `HTTP_${statusCode}`,
        message: `${req.method} ${path} → ${statusCode} (${durationMs}ms)`,
        http: { method: req.method, path, statusCode, durationMs },
      });
    } catch {
      // Best-effort: never let request logging affect the response.
    }
  }
}

/** Parameterised route path when Nest matched one — so every hit on an
 *  endpoint groups together instead of fragmenting by id — falling back to
 *  the raw url for unmatched requests. */
function routePath(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route;
  return route?.path ?? req.originalUrl ?? req.url;
}

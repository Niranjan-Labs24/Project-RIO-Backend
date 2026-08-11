import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RecordSystemLogInput } from '../../modules/system-logs/system-logs.types';

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

function isEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const error = (value as ErrorEnvelope).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  );
}

/** Structural type so the filter doesn't depend on the concrete service —
 *  it is constructed by hand in main.ts, outside the DI graph. */
interface SystemLogRecorder {
  record(input: RecordSystemLogInput): void;
}

@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Pick<Logger, 'error'> = new Logger(AllExceptionsFilter.name),
    // RIO-NFR-016 — optional on purpose: the filter must keep working (and
    // keep logging to stdout) when no recorder is wired, which is exactly
    // what every existing unit test does.
    private readonly systemLogs?: SystemLogRecorder,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (status >= 500) {
        this.logException(exception);
      }
      // RIO-NFR-016 — every error response is recorded here, not just 5xx.
      // This filter is the only place that sees *all* of them: guards run
      // before interceptors, so a 401 from JwtAuthGuard or a 403 from
      // PermissionGuard never reaches the request interceptor at all. A
      // burst of those is exactly the operational signal this log exists
      // for. 4xx is recorded at `warn`, 5xx at `error`.
      if (status >= 400) {
        this.recordSystemLog(exception, status, req, errorCode(payload) ?? `HTTP_${status}`);
      }
      if (isEnvelope(payload)) {
        // Surface the enveloped code/message at the top level too — the FE
        // client reads payload.message (+ machine code) directly (DV-8).
        res.status(status).json({ ...payload, message: payload.error.message, code: payload.error.code });
        return;
      }
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: unknown }).message?.toString() ?? exception.message);
      res.status(status).json({ error: { code: `HTTP_${status}`, message }, message, code: `HTTP_${status}` });
      return;
    }

    this.logException(exception);
    this.recordSystemLog(exception, 500, req, 'INTERNAL_ERROR');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }

  private logException(exception: unknown): void {
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
  }

  /**
   * RIO-NFR-016 — persist the failure alongside the stdout line, so "show me
   * every 5xx for org X in the last 24 hours" is a query rather than a shell
   * session on the container. Wrapped: a logging failure must never replace
   * the response the client is owed.
   */
  private recordSystemLog(
    exception: unknown,
    status: number,
    req: Request | undefined,
    eventCode: string,
  ): void {
    if (!this.systemLogs) return;
    try {
      const clientError = status < 500;
      this.systemLogs.record({
        level: clientError ? 'warn' : 'error',
        // 401/403 are an authentication/authorization signal, not a generic
        // HTTP one — filing them under `auth` is what makes "show me the
        // permission denials for this org" a one-click filter.
        category: status === 401 || status === 403 ? 'auth' : 'http',
        source: AllExceptionsFilter.name,
        eventCode,
        message: exception instanceof Error ? exception.message : String(exception),
        // Stacks only for 5xx. A 404 or a 403 is an expected outcome with a
        // stack that says nothing but "a guard threw" — storing thousands of
        // those buys noise, not diagnostics.
        error: clientError ? undefined : exception,
        http: {
          method: req?.method,
          // `route.path` when Nest matched a route (parameterised, so all
          // hits on one endpoint group together), falling back to the raw
          // url for 404s and anything unmatched.
          path: routePath(req),
          statusCode: status,
        },
      });
    } catch {
      // Swallowed: recording is best-effort and stdout already has the error.
    }
  }
}

/** Pull the machine code out of a standard error envelope, when present. */
function errorCode(payload: unknown): string | undefined {
  if (isEnvelope(payload)) return payload.error.code;
  return undefined;
}

function routePath(req: Request | undefined): string | undefined {
  if (!req) return undefined;
  const route = (req as Request & { route?: { path?: string } }).route;
  return route?.path ?? req.originalUrl ?? req.url;
}

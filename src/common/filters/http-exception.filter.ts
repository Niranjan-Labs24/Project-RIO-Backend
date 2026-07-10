import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';

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

@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Pick<Logger, 'error'> = new Logger(AllExceptionsFilter.name)) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (status >= 500) {
        this.logException(exception);
      }
      if (isEnvelope(payload)) {
        res.status(status).json(payload);
        return;
      }
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: unknown }).message?.toString() ?? exception.message);
      res.status(status).json({ error: { code: `HTTP_${status}`, message } });
      return;
    }

    this.logException(exception);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }

  private logException(exception: unknown): void {
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
  }
}

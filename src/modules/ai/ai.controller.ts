import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { ConfigService } from '../../config/config.service';

export interface AiStatus {
  online: boolean;
}

// System Admin's Dashboard "System Status" panel — a quick-glance signal for
// whether the AI recommendation engine (Gemini) is actually configured, not
// a health check against Gemini itself. systemLogs:read is the same
// System-Admin-exclusive gate the operational log uses, since this is the
// same kind of platform-operational info, not an org-scoped concern.
@Controller('ai')
export class AiController {
  constructor(private readonly config: ConfigService) {}

  @Get('status')
  @RequirePermission('systemLogs', 'read')
  getStatus(): AiStatus {
    return { online: Boolean(this.config.geminiApiKey) };
  }
}

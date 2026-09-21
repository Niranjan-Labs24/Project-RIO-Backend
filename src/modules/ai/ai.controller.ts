import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { ConfigService } from '../../config/config.service';

export interface AiStatus {
  online: boolean;
}

// System Admin's Dashboard "System Status" panel — a quick-glance signal for
// whether the AI recommendation engine is actually configured, not a health
// check against the provider itself. systemLogs:read is the same
// System-Admin-exclusive gate the operational log uses, since this is the
// same kind of platform-operational info, not an org-scoped concern.
@Controller('ai')
export class AiController {
  constructor(private readonly config: ConfigService) {}

  @Get('status')
  @RequirePermission('systemLogs', 'read')
  getStatus(): AiStatus {
    // Whichever provider AI_PROVIDER actually selects. This read Gemini's key
    // unconditionally, which was right when Gemini was the only provider and
    // wrong ever since oci_cohere became the default: a deployment running
    // happily on OCI reported the engine offline on the dashboard, because the
    // key it checked was one such a deployment has no reason to set.
    const online =
      this.config.aiProvider === 'oci_cohere'
        ? // buildOciRequest needs both, and fails to manual mode without either.
          Boolean(this.config.ociGenAiApiKey && this.config.ociGenAiCompartmentId)
        : Boolean(this.config.geminiApiKey);
    return { online };
  }
}

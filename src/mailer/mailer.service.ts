import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { ConfigService } from '../config/config.service';

/**
 * Thin wrapper around Resend — the one place that knows how outbound email
 * actually gets sent, so swapping providers later (SMTP, SES, SendGrid,
 * ...) means rewriting this file only, not any caller. Gracefully "off"
 * when RESEND_API_KEY isn't configured: methods return `false` instead of
 * throwing, so signup keeps working (falling back to its pre-mailer
 * behavior — see AuthService.signup()) rather than breaking account
 * creation over an email-provider hiccup or a not-yet-configured key.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly client: Resend | null;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.resendApiKey;
    this.client = apiKey ? new Resend(apiKey) : null;
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Emails a newly-created NGO Admin their organization name, temporary
   * password, and a link to sign in. Returns `true` if Resend accepted the
   * send, `false` if mailer isn't configured or the send failed — callers
   * decide the fallback (see AuthService.signup()), this never throws.
   */
  async sendTemporaryPassword(
    to: string,
    organizationName: string,
    temporaryPassword: string,
  ): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    const signInUrl = this.config.corsOrigin;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to,
        subject: 'Your Rio account is ready',
        text:
          `"${organizationName}" has been registered on Rio.\n\n` +
          `Temporary password: ${temporaryPassword}\n\n` +
          `Sign in at ${signInUrl} using this email address and the temporary ` +
          `password above. You'll be asked to change it after your first login.`,
      });
      if (error) {
        this.logger.error(`Resend rejected the send to ${to}: ${error.message}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send temporary password email to ${to}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

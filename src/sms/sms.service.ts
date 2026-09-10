import { Injectable, Logger, Optional } from '@nestjs/common';
import Twilio from 'twilio';
import { ConfigService } from '../config/config.service';
import { redactPhone } from '../common/security/redact';
import { SystemLogsService } from '../modules/system-logs/system-logs.service';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client?: Twilio.Twilio;
  private readonly fromNumber?: string;

  constructor(
    private readonly config: ConfigService,
    // RIO-NFR-016 — @Optional so the service still constructs in the unit
    // tests (and anywhere the global SystemLogsModule isn't loaded); a
    // missing recorder degrades to stdout-only, never to a crash.
    @Optional() private readonly systemLogs?: SystemLogsService,
  ) {
    const accountSid = this.config.twilioAccountSid;
    const apiKeySid = this.config.twilioApiKeySid;
    const apiKeySecret = this.config.twilioApiKeySecret;
    const authToken = this.config.twilioAuthToken;
    this.fromNumber = this.config.twilioFromNumber;

    // A from-number is non-negotiable for SMS regardless of auth mode.
    if (!accountSid || !this.fromNumber) return; // not configured — sendOtpCode returns false

    // Bounds every request this client makes (Twilio's own SDK default is
    // 30s otherwise) — see SMS_TIMEOUT_MS in env.schema.ts.
    const opts = { timeout: this.config.smsTimeoutMs };

    if (apiKeySid && apiKeySecret) {
      // API-Key auth: username = key SID, password = key secret, and the
      // account SID passed explicitly since the key alone doesn't carry it.
      // Preferred — a key is independently revocable.
      this.client = Twilio(apiKeySid, apiKeySecret, { ...opts, accountSid });
    } else if (authToken) {
      // Legacy/fallback: the account's root Auth Token.
      this.client = Twilio(accountSid, authToken, opts);
    }
    // else: account SID + from-number present but no usable credential —
    // stays "not configured", same soft-fail path as above.
  }

  /**
   * Citizen public flow OTP delivery over SMS — same soft-fail contract as
   * MailerService's sends (never throws; a hard failure would strand a
   * citizen with no way to get a code).
   */
  async sendOtpCode(phoneNumber: string, code: string): Promise<boolean> {
    if (!this.client || !this.fromNumber) return false;
    try {
      await this.client.messages.create({
        to: phoneNumber,
        from: this.fromNumber,
        body: `Your RIO survey verification code is ${code}. It expires in 10 minutes.`,
      });
      return true;
    } catch (err) {
      this.logger.error(`Failed to text OTP code to ${redactPhone(phoneNumber)}`, err as Error);
      // RIO-NFR-016 — a citizen who never receives their OTP is a support
      // ticket; this is what makes "how many OTP sends failed today, and
      // starting when" answerable without shell access to the container.
      this.systemLogs?.record({
        level: 'error',
        category: 'integration',
        source: SmsService.name,
        eventCode: 'SMS_SEND_FAILED',
        message: `Failed to text OTP code to ${redactPhone(phoneNumber)}`,
        error: err,
        // Redacted recipient only — the code itself and the full number
        // never reach the log.
        context: { provider: 'twilio', recipient: redactPhone(phoneNumber) },
      });
      return false;
    }
  }

  /**
   * Completion reminder for an unfinished citizen survey
   * (SurveyReminderService), used only when the email channel is unavailable
   * or failed. Same soft-fail contract as sendOtpCode.
   *
   * Says the answers were not kept, because they were not: no partial answer
   * data is persisted (client answer, 24 Aug) and the respondent will start
   * the question set again.
   */
  async sendSurveyReminder(phoneNumber: string, publicUrl: string): Promise<boolean> {
    if (!this.client || !this.fromNumber) return false;
    try {
      await this.client.messages.create({
        to: phoneNumber,
        from: this.fromNumber,
        body:
          `You started a RIO survey but did not submit it. Earlier answers were not saved. ` +
          `Finish it here: ${publicUrl}`,
      });
      return true;
    } catch (err) {
      this.logger.error(`Failed to text survey reminder to ${redactPhone(phoneNumber)}`, err as Error);
      this.systemLogs?.record({
        level: 'error',
        category: 'integration',
        source: SmsService.name,
        eventCode: 'SMS_SEND_FAILED',
        message: `Failed to text survey reminder to ${redactPhone(phoneNumber)}`,
        error: err,
        context: { provider: 'twilio', recipient: redactPhone(phoneNumber), kind: 'survey_reminder' },
      });
      return false;
    }
  }
}

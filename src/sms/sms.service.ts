import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

const UNIFONIC_SEND_URL = 'https://el.cloud.unifonic.com/rest/SMS/messages';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Citizen public flow OTP delivery over SMS, via Unifonic's REST API
   * (plain HTTP form POST — no SDK). Same soft-fail contract as
   * MailerService.sendOtpCode (never throws; a hard failure would strand a
   * citizen with no way to get a code).
   */
  async sendOtpCode(phoneNumber: string, code: string): Promise<boolean> {
    const appSid = this.config.unifonicAppSid;
    const senderId = this.config.unifonicSenderId;
    if (!appSid || !senderId) return false; // not configured
    try {
      const body = new URLSearchParams({
        AppSid: appSid,
        SenderID: senderId,
        Body: `Your RIO survey verification code is ${code}. It expires in 10 minutes.`,
        Recipient: phoneNumber,
        responseType: 'JSON',
      });
      const res = await fetch(UNIFONIC_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = (await res.json()) as { success?: boolean; errorCode?: number; message?: string };
      if (!res.ok || data.success === false) {
        this.logger.error(`Unifonic rejected OTP send to ${phoneNumber}: ${data.message ?? res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to text OTP code to ${phoneNumber}`, err as Error);
      return false;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ConfigService } from '../config/config.service';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport?: Transporter;

  constructor(private readonly config: ConfigService) {
    const host = this.config.smtpHost;
    if (!host) return; // not configured — sendTemporaryPassword returns false
    const user = this.config.smtpUser;
    const pass = this.config.smtpPass;
    this.transport = nodemailer.createTransport({
      host,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      auth: user ? { user, pass } : undefined,
    });
  }

  async sendTemporaryPassword(email: string, orgName: string, tempPassword: string): Promise<boolean> {
    if (!this.transport) return false;
    try {
      await this.transport.sendMail({
        from: this.config.mailFrom,
        to: email,
        subject: `Welcome to RIO — ${orgName}`,
        text:
          `An account was created for ${orgName}.\n\n` +
          `Your temporary password is: ${tempPassword}\n\n` +
          `Please sign in and change it immediately.`,
      });
      return true;
    } catch (err) {
      this.logger.error(`Failed to email temporary password to ${email}`, err as Error);
      return false;
    }
  }
}

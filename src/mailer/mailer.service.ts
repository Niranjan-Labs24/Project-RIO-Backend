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
    const signInUrl = this.config.corsOrigin;
    try {
      await this.transport.sendMail({
        from: this.config.mailFrom,
        to: email,
        subject: `Welcome to RIO — ${orgName}`,
        text: temporaryPasswordText({ orgName, email, tempPassword, signInUrl }),
        html: temporaryPasswordHtml({ orgName, email, tempPassword, signInUrl }),
      });
      return true;
    } catch (err) {
      this.logger.error(`Failed to email temporary password to ${email}`, err as Error);
      return false;
    }
  }

  /**
   * Routes a public enquiry to an org's research officers (or admins). Returns
   * false rather than throwing, exactly like sendTemporaryPassword — callers
   * decide what an undelivered message means. ContactService treats false as a
   * 503 so the sender is never told an enquiry was delivered when it wasn't.
   *
   * Recipients go in `bcc`: they are staff addresses of one org, and the
   * enquirer is an outside party who must not receive the roster of everyone it
   * reached. `replyTo` is the enquirer, so a reply reaches the person asking
   * rather than the noreply mailbox.
   */
  async sendContactRequest(recipients: string[], enquiry: ContactEnquiryInput): Promise<boolean> {
    if (!this.transport) return false;
    if (recipients.length === 0) return false;
    try {
      await this.transport.sendMail({
        from: this.config.mailFrom,
        to: this.config.mailFrom,
        bcc: recipients,
        replyTo: enquiry.email,
        subject: `RIO enquiry — ${enquiry.name} (${enquiry.region})`,
        text: contactRequestText(enquiry),
        html: contactRequestHtml(enquiry),
      });
      return true;
    } catch (err) {
      this.logger.error(`Failed to email contact enquiry for ${enquiry.orgName}`, err as Error);
      return false;
    }
  }
}

interface ContactEnquiryInput {
  orgName: string;
  name: string;
  email: string;
  region: string;
  purpose: string;
}

function contactRequestText({ orgName, name, email, region, purpose }: ContactEnquiryInput): string {
  return (
    `New contact enquiry for ${orgName}\n\n` +
    `Name: ${name}\n` +
    `Email: ${email}\n` +
    `Region: ${region}\n\n` +
    `Purpose:\n${purpose}\n\n` +
    `Reply directly to this email to reach ${name}.`
  );
}

function contactRequestHtml({ orgName, name, email, region, purpose }: ContactEnquiryInput): string {
  // Every value here is attacker-supplied (public form) — escape before it
  // reaches markup. Same subset as temporaryPasswordHtml: safe in attribute
  // context too, since email is interpolated into href="mailto:...".
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const row = (label: string, value: string): string => `
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">${esc(label)}</p>
                      <p style="margin:0 0 16px;font-size:14px;color:#111827;font-weight:600;">${esc(value)}</p>`;

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#111827;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">New contact enquiry</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563;">
                  Someone has reached out to ${esc(orgName)} through the RIO
                  sign-in page.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
                  <tr>
                    <td style="padding:16px 20px;">${row('Name', name)}${row('Email', email)}${row('Region', region)}
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Purpose</p>
                      <p style="margin:0;font-size:14px;line-height:1.6;color:#111827;white-space:pre-wrap;">${esc(purpose)}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background-color:#111827;">
                      <a href="mailto:${esc(email)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        Reply to ${esc(name)}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

interface TemporaryPasswordEmailInput {
  orgName: string;
  email: string;
  tempPassword: string;
  signInUrl: string;
}

function temporaryPasswordText({ orgName, email, tempPassword, signInUrl }: TemporaryPasswordEmailInput): string {
  return (
    `Welcome to RIO, ${orgName}!\n\n` +
    `An account has been created for your organization. Use the credentials ` +
    `below to sign in, then set your own password.\n\n` +
    `Workspace: ${orgName}\n` +
    `Email: ${email}\n` +
    `Temporary password: ${tempPassword}\n\n` +
    `Sign in: ${signInUrl}\n\n` +
    `You'll be asked to change this password the first time you sign in.`
  );
}

// Table-based layout + inline styles — the only markup/CSS subset that
// renders consistently across email clients (Gmail/Outlook strip <style>
// blocks and most CSS layout properties).
function temporaryPasswordHtml({ orgName, email, tempPassword, signInUrl }: TemporaryPasswordEmailInput): string {
  // Escapes text-content chars (&, <, >) and quote chars (", ') too, so a
  // value is safe in attribute context as well — signInUrl is interpolated
  // into href="...".
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#111827;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">Welcome to RIO, ${esc(orgName)}!</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563;">
                  An account has been created for your organization. Use the
                  credentials below to sign in, then you'll be asked to set
                  your own password.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Workspace</p>
                      <p style="margin:0 0 16px;font-size:14px;color:#111827;font-weight:600;">${esc(orgName)}</p>
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Email</p>
                      <p style="margin:0 0 16px;font-size:14px;color:#111827;font-weight:600;">${esc(email)}</p>
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Temporary password</p>
                      <p style="margin:0;font-size:14px;color:#111827;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(tempPassword)}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background-color:#111827;">
                      <a href="${esc(signInUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        Sign in to RIO
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  You'll be asked to change this password the first time you
                  sign in. If you weren't expecting this email, you can
                  safely ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

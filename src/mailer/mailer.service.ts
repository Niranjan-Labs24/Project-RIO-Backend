import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { ConfigService } from '../config/config.service';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly client?: Resend;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.resendApiKey;
    if (!apiKey) return; // not configured — sendTemporaryPassword returns false
    this.client = new Resend(apiKey);
  }

  async sendTemporaryPassword(email: string, orgName: string, tempPassword: string): Promise<boolean> {
    if (!this.client) return false;
    const signInUrl = this.config.corsOrigin;
    const mail = {
      from: this.config.mailFrom,
      to: email,
      subject: `Welcome to RIO — ${orgName}`,
      text: temporaryPasswordText({ orgName, email, tempPassword, signInUrl }),
      html: temporaryPasswordHtml({ orgName, email, tempPassword, signInUrl }),
    };
    // One retry after a short delay before falling back to the "reveal in
    // response" path — a single attempt against the provider occasionally
    // fails on transient network blips or brief rate-limiting, not a real
    // config problem, and shouldn't immediately expose the temp password
    // client-side when a second try would have gone through.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { error } = await this.client.emails.send(mail);
        if (!error) return true;
        this.logger.error(
          `Failed to email temporary password to ${email} (attempt ${attempt}/2): ${error.name} ${error.message}`,
        );
      } catch (err) {
        this.logger.error(`Failed to email temporary password to ${email} (attempt ${attempt}/2)`, err as Error);
      }
      if (attempt === 2) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  /**
   * Forgot-password reset link. Same soft-fail contract as every other send
   * here — the caller (AuthService.forgotPassword) always returns a generic
   * "if that email exists..." response regardless of what this returns, so
   * delivery failure never leaks whether the account exists.
   */
  async sendPasswordResetEmail(email: string, resetUrl: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject: 'Reset your RIO password',
        text: passwordResetText({ resetUrl }),
        html: passwordResetHtml({ resetUrl }),
      });
      if (error) {
        this.logger.error(`Failed to email password reset link to ${email}: ${error.name} ${error.message}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email password reset link to ${email}`, err as Error);
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
    if (!this.client) return false;
    if (recipients.length === 0) return false;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: this.config.mailFrom,
        bcc: recipients,
        replyTo: enquiry.email,
        subject: `RIO enquiry — ${enquiry.name} (${enquiry.region})`,
        text: contactRequestText(enquiry),
        html: contactRequestHtml(enquiry),
      });
      if (error) {
        this.logger.error(`Failed to email contact enquiry for ${enquiry.orgName}: ${error.name} ${error.message}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email contact enquiry for ${enquiry.orgName}`, err as Error);
      return false;
    }
  }

  /**
   * Shares a public survey link (Publish Survey/QR) by email — the link
   * itself plus the same QR code shown in-app, embedded as an inline image
   * (`cid:`) rather than a regular attachment, so it renders inline in the
   * email body instead of showing up as a downloadable file. A `mailto:`
   * link can carry the URL but has no way to attach an image at all, which
   * is why this goes through the real mailer instead.
   */
  async sendSurveyLink(email: string, input: SurveyLinkEmailInput): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject: `Survey link: ${input.needTitle}`,
        text: surveyLinkText(input),
        html: surveyLinkHtml(input),
        attachments: [
          {
            filename: 'survey-qr-code.png',
            content: input.qrCodePng,
            contentId: 'survey-qr-code',
          },
        ],
      });
      if (error) {
        this.logger.error(`Failed to email survey link to ${email}: ${error.name} ${error.message}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email survey link to ${email}`, err as Error);
      return false;
    }
  }
}

interface SurveyLinkEmailInput {
  needTitle: string;
  linkLabel: string;
  publicUrl: string;
  qrCodePng: Buffer;
}

function surveyLinkText({ needTitle, linkLabel, publicUrl }: SurveyLinkEmailInput): string {
  return (
    `You've been sent a survey link for "${needTitle}" (${linkLabel}).\n\n` +
    `Open the survey: ${publicUrl}\n\n` +
    `You can also scan the attached QR code with a phone camera to open it directly.`
  );
}

// Same table-based layout + inline styles as the other templates in this
// file (Gmail/Outlook strip <style> blocks and most CSS layout properties).
// The QR code is referenced via cid: (see sendSurveyLink's attachments),
// not a data: URI — data: URIs in <img src> are stripped by several major
// email clients (Gmail included), cid: embedding is the reliable path.
function surveyLinkHtml({ needTitle, linkLabel, publicUrl }: SurveyLinkEmailInput): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Brand colors, not this file's usual neutral #111827 header — pulled from
  // the frontend's own design tokens (src/styles/tokens.css): --primary
  // resolves to --palette-primary-700 (#145463) and --secondary to
  // --palette-secondary-600 (#53695c) in light mode. Email clients don't
  // read CSS custom properties or oklch(), so these are the literal sRGB
  // hex values those tokens compute to, not a re-derivation of the palette.
  const PRIMARY = "#145463";
  const SECONDARY_TINT = "#daeee1"; // --palette-secondary-100, light accent behind the QR code

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:${PRIMARY};padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${esc(needTitle)}</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563;">
                  You've been sent a survey link (${esc(linkLabel)}). Open it
                  directly, or scan the QR code below with a phone camera.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                  <tr>
                    <td style="border-radius:8px;background-color:${PRIMARY};">
                      <a href="${esc(publicUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        Open Survey
                      </a>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;background-color:${SECONDARY_TINT};border-radius:8px;">
                  <tr>
                    <td style="padding:12px;">
                      <img src="cid:survey-qr-code" alt="QR code for the survey link" width="180" height="180" style="display:block;border-radius:4px;" />
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

interface PasswordResetEmailInput {
  resetUrl: string;
}

function passwordResetText({ resetUrl }: PasswordResetEmailInput): string {
  return (
    `We received a request to reset your RIO password.\n\n` +
    `Reset your password: ${resetUrl}\n\n` +
    `This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.`
  );
}

function passwordResetHtml({ resetUrl }: PasswordResetEmailInput): string {
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
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">Reset your password</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563;">
                  We received a request to reset your RIO password. Click the
                  button below to choose a new one. This link expires in 30
                  minutes.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background-color:#111827;">
                      <a href="${esc(resetUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        Reset Password
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  If you didn't request this, you can safely ignore this email.
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

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Resend } from 'resend';
import { ConfigService } from '../config/config.service';
import { redactEmail } from '../common/security/redact';
import { SystemLogsService } from '../modules/system-logs/system-logs.service';

/**
 * Forces every transactional email in this file to render in light mode
 * regardless of the recipient's device/client dark-mode setting — without
 * this, Gmail/Apple Mail's auto-dark-mode re-colors the templates' explicit
 * light palette (backgrounds, badge tint, brand header) into a dark,
 * washed-out version the templates were never designed to look like
 * (reported 2026-09-16: the RIO header and QR-code tint both got inverted).
 * `color-scheme`/`supported-color-schemes` meta tags cover Apple Mail and
 * modern Outlook; the `[data-ogsc]` selector is Gmail's own dark-mode hook
 * (added to elements it re-colors) and is the only reliable way to pin
 * Gmail specifically back to the original colors.
 */
function lightModeEmailHead(colors: {
  page: string;
  card: string;
  header: string;
  accent?: string;
}): string {
  return `
<head>
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <style>
    :root { color-scheme: light only; supported-color-schemes: light only; }
    /* Gmail's dark-mode pass tags every element it re-colors with
       data-ogsc — these rules target that exact hook to force the
       template's real colors back, since a plain (non-attribute-scoped)
       override loses to Gmail's own injected stylesheet. */
    [data-ogsc] .email-page { background-color: ${colors.page} !important; }
    [data-ogsc] .email-card { background-color: ${colors.card} !important; }
    [data-ogsc] .email-header { background-color: ${colors.header} !important; }
    [data-ogsc] .email-header-text { color: #ffffff !important; }
    ${colors.accent ? `[data-ogsc] .email-accent { background-color: ${colors.accent} !important; }` : ''}
  </style>
</head>`;
}

/**
 * Client-agnostic shape both providers below satisfy, so every one of the
 * seven send methods in this file can keep calling
 * `this.client.emails.send(mail)` unchanged regardless of which provider is
 * actually configured — only the constructor and this adapter know which
 * one is in play.
 */
interface EmailSendResult {
  error?: { name: string; message: string };
}
interface EmailMail {
  from: string;
  to: string | string[];
  subject: string;
  text: string;
  html: string;
  bcc?: string | string[];
  replyTo?: string;
  attachments?: { filename: string; content: Buffer; contentId?: string }[];
}
interface EmailClientLike {
  emails: { send(mail: EmailMail): Promise<EmailSendResult> };
}

/**
 * Neither provider's attachment payload below carried a MIME type before —
 * both defaulted to `application/octet-stream` (generic binary), and email
 * clients broadly refuse to render that inline as an image even with a
 * matching `content_id`/disposition:"inline". This is what left
 * sendSurveyLink's QR code showing as blank space (reported 2026-09-16,
 * SendGrid). Limited to the file types this codebase's attachments actually
 * are — the QR PNG here, plus common cases if attachments grow.
 */
function mimeTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Twilio's Emails API (POST https://comms.twilio.com/v1/Emails) — a raw HTTP
 * call, not in the `twilio` SDK, with HTTP Basic auth against a SEPARATE
 * API-Key pair from the one SmsService uses (TWILIO_EMAIL_API_KEY_SID/SECRET,
 * the "rio" key issued for the Comms/Emails product under the impetus.sa
 * account). `from` is always the verified impetus.sa sending address, not
 * MAIL_FROM — Twilio rejects sends from an unverified address the same way
 * Resend's sandbox mode rejects sends to an unverified recipient.
 *
 * The endpoint replies 202 + an operationId (queued, not "delivered"); any
 * other status is treated as a send failure. Attachment mapping (used only
 * by sendSurveyLink's inline QR code) is best-effort and has not been
 * confirmed against a real Twilio response — verify before relying on it.
 */
class TwilioEmailClient implements EmailClientLike {
  constructor(
    private readonly apiKeySid: string,
    private readonly apiKeySecret: string,
    private readonly fromAddress: string,
    private readonly fromName: string,
  ) {}

  emails = {
    send: async (mail: EmailMail): Promise<EmailSendResult> => {
      try {
        const toAddresses = Array.isArray(mail.to) ? mail.to : [mail.to];
        const payload: Record<string, unknown> = {
          from: { address: this.fromAddress, name: this.fromName },
          to: toAddresses.map((address) => ({ address })),
          content: { subject: mail.subject, html: mail.html, text: mail.text },
        };
        if (mail.bcc) {
          const bccAddresses = Array.isArray(mail.bcc) ? mail.bcc : [mail.bcc];
          payload.bcc = bccAddresses.map((address) => ({ address }));
        }
        if (mail.replyTo) {
          payload.replyTo = { address: mail.replyTo };
        }
        if (mail.attachments?.length) {
          payload.attachments = mail.attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString('base64'),
            contentId: a.contentId,
            contentType: mimeTypeFor(a.filename),
          }));
        }
        const auth = Buffer.from(`${this.apiKeySid}:${this.apiKeySecret}`).toString('base64');
        const res = await fetch('https://comms.twilio.com/v1/Emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
          body: JSON.stringify(payload),
        });
        if (res.ok) return {};
        const body = await res.text().catch(() => '');
        return { error: { name: `HTTP_${res.status}`, message: body || res.statusText } };
      } catch (err) {
        return {
          error: {
            name: 'TWILIO_EMAIL_REQUEST_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };
}

/**
 * SendGrid's Mail Send API (POST https://api.sendgrid.com/v3/mail/send) —
 * Bearer-token auth with a plain API key, a completely different product
 * and credential shape from TwilioEmailClient above despite both living
 * under the Twilio umbrella: the client's Indian Twilio trial account only
 * exposes email sending through SendGrid, not the native comms.twilio.com
 * Emails API the impetus.sa account uses. Verified 2026-09-16 with a real
 * test send (202 Accepted, empty body — SendGrid's normal success response).
 *
 * `from`/`replyTo` must be a verified sender on that SendGrid account, same
 * unverified-sender rejection pattern as the other two providers.
 */
class SendGridEmailClient implements EmailClientLike {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
    private readonly fromName: string,
  ) {}

  emails = {
    send: async (mail: EmailMail): Promise<EmailSendResult> => {
      try {
        const toAddresses = Array.isArray(mail.to) ? mail.to : [mail.to];
        const personalization: Record<string, unknown> = {
          to: toAddresses.map((email) => ({ email })),
        };
        if (mail.bcc) {
          const bccAddresses = Array.isArray(mail.bcc) ? mail.bcc : [mail.bcc];
          personalization.bcc = bccAddresses.map((email) => ({ email }));
        }
        const payload: Record<string, unknown> = {
          personalizations: [personalization],
          from: { email: this.fromAddress, name: this.fromName },
          subject: mail.subject,
          content: [
            { type: 'text/plain', value: mail.text },
            { type: 'text/html', value: mail.html },
          ],
        };
        if (mail.replyTo) {
          payload.reply_to = { email: mail.replyTo };
        }
        if (mail.attachments?.length) {
          payload.attachments = mail.attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString('base64'),
            type: mimeTypeFor(a.filename),
            content_id: a.contentId,
            disposition: a.contentId ? 'inline' : 'attachment',
          }));
        }
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) return {};
        const body = await res.text().catch(() => '');
        return { error: { name: `HTTP_${res.status}`, message: body || res.statusText } };
      } catch (err) {
        return {
          error: {
            name: 'SENDGRID_REQUEST_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };
}

/**
 * Thin adapter so Resend satisfies the same EmailClientLike shape as
 * TwilioEmailClient — Resend types `error` as `null` (not `undefined`) when
 * absent, which is the only mismatch.
 */
class ResendEmailClient implements EmailClientLike {
  private readonly resend: Resend;
  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }
  emails = {
    send: async (mail: EmailMail): Promise<EmailSendResult> => {
      const { error } = await this.resend.emails.send(mail);
      return error ? { error: { name: error.name, message: error.message } } : {};
    },
  };
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly client?: EmailClientLike;

  constructor(
    private readonly config: ConfigService,
    // RIO-NFR-016 — @Optional so the service still constructs in the unit
    // tests (and anywhere the global SystemLogsModule isn't loaded); a
    // missing recorder degrades to stdout-only, never to a crash.
    @Optional() private readonly systemLogs?: SystemLogsService,
  ) {
    if (this.config.mailProvider === 'twilio') {
      const sid = this.config.twilioEmailApiKeySid;
      const secret = this.config.twilioEmailApiKeySecret;
      if (!sid || !secret) return; // not configured — every send method returns false
      this.client = new TwilioEmailClient(
        sid,
        secret,
        this.config.twilioEmailFromAddress,
        this.config.twilioEmailFromName,
      );
      return;
    }
    if (this.config.mailProvider === 'sendgrid') {
      const apiKey = this.config.sendgridApiKey;
      const fromAddress = this.config.sendgridFromAddress;
      if (!apiKey || !fromAddress) return; // not configured — every send method returns false
      this.client = new SendGridEmailClient(apiKey, fromAddress, this.config.sendgridFromName);
      return;
    }
    const apiKey = this.config.resendApiKey;
    if (!apiKey) return; // not configured — sendTemporaryPassword returns false
    this.client = new ResendEmailClient(apiKey);
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
          `Failed to email temporary password to ${redactEmail(email)} (attempt ${attempt}/2): ${error.name} ${error.message}`,
        );
      } catch (err) {
        this.logger.error(`Failed to email temporary password to ${redactEmail(email)} (attempt ${attempt}/2)`, err as Error);
      }
      if (attempt === 2) {
        this.recordSendFailure('temporary_password', redactEmail(email), { attempts: 2 });
        return false;
      }
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
        this.logger.error(`Failed to email password reset link to ${redactEmail(email)}: ${error.name} ${error.message}`);
        this.recordSendFailure('password_reset', redactEmail(email), { providerError: `${error.name}: ${error.message}` });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email password reset link to ${redactEmail(email)}`, err as Error);
      this.recordSendFailure('password_reset', redactEmail(email), {}, err);
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
  /**
   * RIO MFA — "Sign in with OTP" over email. Code-complete but deliberately
   * inert until `EMAIL_OTP_ENABLED=true` (client decision — SMS ships
   * first): AuthService.requestLoginOtp never calls this while the flag is
   * off, so `this.client` being configured or not doesn't matter yet
   * either way. Kept here (rather than left unwritten) so turning email OTP
   * on later is a config flip, not a new send method.
   */
  async sendLoginOtpEmail(email: string, code: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject: 'Your RIO sign-in code',
        text: `Your RIO sign-in verification code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
        html: `<p>Your RIO sign-in verification code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you didn't request this, ignore this email.</p>`,
      });
      if (error) {
        this.logger.error(`Failed to email login OTP code to ${redactEmail(email)}: ${error.name} ${error.message}`);
        this.recordSendFailure('login_otp', redactEmail(email), { providerError: `${error.name}: ${error.message}` });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email login OTP code to ${redactEmail(email)}`, err as Error);
      this.recordSendFailure('login_otp', redactEmail(email), {}, err);
      return false;
    }
  }

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
        this.recordSendFailure('contact_enquiry', enquiry.orgName, { providerError: `${error.name}: ${error.message}` });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email contact enquiry for ${enquiry.orgName}`, err as Error);
      this.recordSendFailure('contact_enquiry', enquiry.orgName, {}, err);
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
        this.logger.error(`Failed to email survey link to ${redactEmail(email)}: ${error.name} ${error.message}`);
        this.recordSendFailure('survey_link', redactEmail(email), { providerError: `${error.name}: ${error.message}` });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email survey link to ${redactEmail(email)}`, err as Error);
      this.recordSendFailure('survey_link', redactEmail(email), {}, err);
      return false;
    }
  }

  /**
   * Completion reminder for a survey a citizen started and did not submit
   * (SurveyReminderService). Same soft-fail contract as every other send
   * here — a missed reminder is a missed nudge, never a failed sweep.
   *
   * The wording deliberately does NOT say "continue where you left off": no
   * partial answers are stored (client answer, 24 Aug — a survey becomes a
   * data record only on formal submission), so the respondent starts the
   * question set again and the message has to be honest about that.
   */
  async sendSurveyReminder(email: string, input: SurveyReminderEmailInput): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject: `Reminder: your survey response for ${input.needTitle} is unfinished`,
        text: surveyReminderText(input),
        html: surveyReminderHtml(input),
      });
      if (error) {
        this.logger.error(`Failed to email survey reminder to ${redactEmail(email)}: ${error.name} ${error.message}`);
        this.recordSendFailure('survey_reminder', redactEmail(email), { providerError: `${error.name}: ${error.message}` });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email survey reminder to ${redactEmail(email)}`, err as Error);
      this.recordSendFailure('survey_reminder', redactEmail(email), {}, err);
      return false;
    }
  }

  /**
   * RIO-NFR-010 — a backup failed.
   *
   * The whole point of this ticket is that a backup which fails quietly is
   * indistinguishable from one that never ran. `backup_runs` records it and
   * SystemLog records it, but both are pull: somebody has to go and look. This
   * is the push, and it is the difference between finding out on Tuesday and
   * finding out during a restore.
   *
   * Same soft-fail contract as every other send here. A mail failure must never
   * turn a recorded backup failure into an unhandled exception on top of it.
   */
  async sendBackupFailureAlert(
    recipients: string[],
    input: { kind: string; error: string; runId: string; startedAt: Date },
  ): Promise<boolean> {
    if (!this.client) return false;
    if (recipients.length === 0) return false;

    const when = input.startedAt.toISOString();
    const subject = `RIO backup FAILED — ${input.kind}`;
    // The error text is included in full. It is written by pg_dump or by this
    // module, carries no tenant data, and the first question an administrator
    // asks is "why" — sending them to a screen to find out wastes the alert.
    const text =
      `A ${input.kind} backup failed.\n\n` +
      `Started : ${when}\n` +
      `Run     : ${input.runId}\n\n` +
      `Error:\n${input.error}\n\n` +
      `Until this is resolved the platform has no current ${input.kind} backup.\n` +
      `See System Administration -> Backups.`;

    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: this.config.mailFrom,
        // BCC so one administrator cannot see the others addresses.
        bcc: recipients,
        subject,
        text,
        html: backupFailureHtml({ ...input, when }),
      });
      if (error) {
        this.logger.error(
          `Failed to email backup failure alert: ${error.name} ${error.message}`,
        );
        this.recordSendFailure('backup_failure_alert', 'system admins', {
          providerError: `${error.name}: ${error.message}`,
        });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error('Failed to email backup failure alert', err as Error);
      this.recordSendFailure('backup_failure_alert', 'system admins', {}, err);
      return false;
    }
  }

  /**
   * RIO-NFR-016 — one persisted row per *give-up*, not per attempt: the
   * retry inside sendTemporaryPassword is normal transient behaviour, and
   * logging both tries would double every failure on the System Logs
   * summary. Recipients are redacted (redactEmail) before they reach the
   * table — an operational log is not a place to accumulate PII.
   */
  private recordSendFailure(
    kind: string,
    recipient: string,
    context: Record<string, unknown>,
    error?: unknown,
  ): void {
    this.systemLogs?.record({
      level: 'error',
      category: 'integration',
      source: MailerService.name,
      eventCode: 'MAILER_SEND_FAILED',
      message: `Failed to send ${kind} email to ${recipient}`,
      error,
      context: { ...context, provider: this.config.mailProvider, kind, recipient },
    });
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
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: PRIMARY, accent: SECONDARY_TINT })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="${PRIMARY}" class="email-header" style="background-color:${PRIMARY};padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
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
                <table role="presentation" cellpadding="0" cellspacing="0" bgcolor="${SECONDARY_TINT}" class="email-accent" style="margin-top:16px;background-color:${SECONDARY_TINT};border-radius:8px;">
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
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: '#111827' })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="#111827" class="email-header" style="background-color:#111827;padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
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
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: '#111827' })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="#111827" class="email-header" style="background-color:#111827;padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
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
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: '#111827' })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="#111827" class="email-header" style="background-color:#111827;padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
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

interface SurveyReminderEmailInput {
  needTitle: string;
  publicUrl: string;
}

function surveyReminderText({ needTitle, publicUrl }: SurveyReminderEmailInput): string {
  return (
    `You started the survey for "${needTitle}" but did not finish it.

` +
    `Open the survey again: ${publicUrl}

` +
    `Your earlier answers were not saved, so the questions will start from the ` +
    `beginning. A response only counts once it is submitted.

` +
    `If you would rather not take part, no action is needed — you will not be reminded again after this.`
  );
}

function surveyReminderHtml({ needTitle, publicUrl }: SurveyReminderEmailInput): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // Same brand colors as surveyLinkHtml — see its comment for why these are
  // literal hex rather than the design tokens they come from.
  const PRIMARY = "#145463";
  return `
<!doctype html>
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: PRIMARY })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="${PRIMARY}" class="email-header" style="background-color:${PRIMARY};padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${esc(needTitle)}</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563;">
                  You started this survey but did not finish it. Your earlier answers
                  were not saved, so the questions will start from the beginning &mdash;
                  a response only counts once it is submitted.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                  <tr>
                    <td style="border-radius:8px;background-color:${PRIMARY};">
                      <a href="${esc(publicUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        Finish the survey
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">
                  If you would rather not take part, no action is needed.
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

/** RIO-NFR-010 — the failure alert body. Plain and unmissable, not branded. */
function backupFailureHtml(input: {
  kind: string;
  error: string;
  runId: string;
  when: string;
}): string {
  // Local, as in every other builder in this file. The error text comes from
  // pg_dump and is interpolated into HTML, so escaping is not optional.
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  return `<!doctype html>
<html>${lightModeEmailHead({ page: '#f9fafb', card: '#ffffff', header: '#ffffff' })}
  <body class="email-page" style="margin:0;padding:24px;background-color:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #fecaca;">
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#b91c1c;">
            Backup failed &mdash; ${esc(input.kind)}
          </p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
            Until this is resolved the platform has no current ${esc(input.kind)} backup.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;font-size:13px;color:#374151;">
            <tr><td style="padding:4px 0;color:#6b7280;">Started</td><td style="padding:4px 0;">${esc(input.when)}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;">Run</td><td style="padding:4px 0;font-family:monospace;">${esc(input.runId)}</td></tr>
          </table>
          <pre style="margin:0 0 16px;padding:12px;background:#f3f4f6;border-radius:8px;font-size:12px;line-height:1.5;color:#111827;white-space:pre-wrap;word-break:break-word;">${esc(input.error)}</pre>
          <p style="margin:0;font-size:12px;color:#6b7280;">
            System Administration &rarr; Backups
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

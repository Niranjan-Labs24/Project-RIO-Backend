import { Injectable, Logger, Optional } from '@nestjs/common';
import { Resend } from 'resend';
import { ConfigService } from '../config/config.service';
import { redactEmail } from '../common/security/redact';
import { SystemLogsService } from '../modules/system-logs/system-logs.service';
import type { SupportedLocale } from '../modules/translation/translation.types';

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

/**
 * One mail account's settings, flattened out of ConfigService so the same
 * selection logic can build the main client and the survey-OTP-only client
 * from two unrelated sets of credentials.
 */
interface MailAccount {
  provider: 'resend' | 'twilio' | 'sendgrid';
  resendApiKey?: string;
  twilioEmailApiKeySid?: string;
  twilioEmailApiKeySecret?: string;
  twilioEmailFromAddress?: string;
  twilioEmailFromName: string;
  sendgridApiKey?: string;
  sendgridFromAddress?: string;
  sendgridFromName: string;
}

/**
 * Builds the transport for one account, or `undefined` when that account is
 * not fully configured — the long-standing "not configured, soft-fail"
 * convention, not an error: a missing key leaves the client unset and the
 * send methods return false rather than throwing at boot.
 */
function buildEmailClient(account: MailAccount): EmailClientLike | undefined {
  if (account.provider === 'twilio') {
    const sid = account.twilioEmailApiKeySid;
    const secret = account.twilioEmailApiKeySecret;
    const fromAddress = account.twilioEmailFromAddress;
    if (!sid || !secret || !fromAddress) return undefined;
    return new TwilioEmailClient(sid, secret, fromAddress, account.twilioEmailFromName);
  }
  if (account.provider === 'sendgrid') {
    const apiKey = account.sendgridApiKey;
    const fromAddress = account.sendgridFromAddress;
    if (!apiKey || !fromAddress) return undefined;
    return new SendGridEmailClient(apiKey, fromAddress, account.sendgridFromName);
  }
  if (!account.resendApiKey) return undefined;
  return new ResendEmailClient(account.resendApiKey);
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly client?: EmailClientLike;
  /**
   * The public survey's OTP, and only that, can be billed to a second
   * account (SURVEY_OTP_MAIL_PROVIDER). Undefined whenever that is unset —
   * which is the default — so every other deployment keeps exactly one
   * client and sendCitizenOtpEmail behaves as it did before.
   */
  private readonly surveyOtpClient?: EmailClientLike;
  private readonly surveyOtpProvider?: 'resend' | 'twilio' | 'sendgrid';
  private readonly surveyOtpFrom?: string;

  constructor(
    private readonly config: ConfigService,
    // RIO-NFR-016 — @Optional so the service still constructs in the unit
    // tests (and anywhere the global SystemLogsModule isn't loaded); a
    // missing recorder degrades to stdout-only, never to a crash.
    @Optional() private readonly systemLogs?: SystemLogsService,
  ) {
    this.client = buildEmailClient({
      provider: this.config.mailProvider,
      resendApiKey: this.config.resendApiKey,
      twilioEmailApiKeySid: this.config.twilioEmailApiKeySid,
      twilioEmailApiKeySecret: this.config.twilioEmailApiKeySecret,
      twilioEmailFromAddress: this.config.twilioEmailFromAddress,
      twilioEmailFromName: this.config.twilioEmailFromName,
      sendgridApiKey: this.config.sendgridApiKey,
      sendgridFromAddress: this.config.sendgridFromAddress,
      sendgridFromName: this.config.sendgridFromName,
    });

    const otpProvider = this.config.surveyOtpMailProvider;
    if (!otpProvider) return; // the default — citizen OTP shares this.client
    const otpClient = buildEmailClient({
      provider: otpProvider,
      resendApiKey: this.config.surveyOtpResendApiKey,
      twilioEmailApiKeySid: this.config.surveyOtpTwilioEmailApiKeySid,
      twilioEmailApiKeySecret: this.config.surveyOtpTwilioEmailApiKeySecret,
      twilioEmailFromAddress: this.config.surveyOtpTwilioEmailFromAddress,
      twilioEmailFromName: this.config.surveyOtpTwilioEmailFromName,
      sendgridApiKey: this.config.surveyOtpSendgridApiKey,
      sendgridFromAddress: this.config.surveyOtpSendgridFromAddress,
      sendgridFromName: this.config.surveyOtpSendgridFromName,
    });
    if (!otpClient) {
      // Deliberately a warning and not a throw. Someone asked for a separate
      // OTP account and mistyped a credential; refusing to start, or leaving
      // the OTP unsendable, would block every survey respondent over a
      // billing preference. Falling back to the main account keeps the
      // survey working and says loudly why the bill is landing here.
      this.logger.warn(
        `SURVEY_OTP_MAIL_PROVIDER is '${otpProvider}' but its credentials are incomplete — ` +
          'citizen OTP emails will fall back to the main mail account.',
      );
      return;
    }
    this.surveyOtpClient = otpClient;
    this.surveyOtpProvider = otpProvider;
    // Only ResendEmailClient reads mail.from; the Twilio and SendGrid
    // clients carry their own verified sender and ignore it.
    this.surveyOtpFrom = this.config.surveyOtpMailFrom ?? this.config.mailFrom;
  }

  // `locale` — UAT-11 (Ganesh's brief, 2026-09-29): send in the single
  // language the recipient is actually using, not both. The caller (see
  // OrganizationsService/UsersService) reads it via `requestLocale()` from
  // the x-rio-locale header already on the SAME request that creates this
  // account — the admin doing the inviting, since the invited user has
  // never signed in yet to have a language of their own. Draft Arabic
  // copy — pending translation review, same as every other new
  // citizen/user-facing string in this pass.
  async sendTemporaryPassword(
    email: string,
    orgName: string,
    tempPassword: string,
    locale: SupportedLocale = 'en',
  ): Promise<boolean> {
    if (!this.client) return false;
    const signInUrl = this.config.corsOrigin;
    const mail = {
      from: this.config.mailFrom,
      to: email,
      subject:
        locale === 'ar' ? `مرحبًا بك في RIO — ${orgName}` : `Welcome to RIO — ${orgName}`,
      text: temporaryPasswordText({ orgName, email, tempPassword, signInUrl }, locale),
      html: temporaryPasswordHtml({ orgName, email, tempPassword, signInUrl }, locale),
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
  async sendPasswordResetEmail(
    email: string,
    resetUrl: string,
    locale: SupportedLocale = 'en',
  ): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject: locale === 'ar' ? 'إعادة تعيين كلمة مرور RIO الخاصة بك' : 'Reset your RIO password',
        text: passwordResetText({ resetUrl }, locale),
        html: passwordResetHtml({ resetUrl }, locale),
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
  async sendLoginOtpEmail(
    email: string,
    code: string,
    locale: SupportedLocale = 'en',
  ): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject: locale === 'ar' ? 'رمز تسجيل الدخول الخاص بك في RIO' : 'Your RIO sign-in code',
        text:
          locale === 'ar'
            ? `رمز التحقق لتسجيل الدخول إلى RIO الخاص بك هو ${code}. تنتهي صلاحيته خلال 10 دقائق. إذا لم تطلب هذا، يُرجى تجاهل هذا البريد الإلكتروني.`
            : `Your RIO sign-in verification code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
        html:
          locale === 'ar'
            ? `<div dir="rtl" lang="ar"><p>رمز التحقق لتسجيل الدخول إلى RIO الخاص بك هو <strong>${code}</strong>. تنتهي صلاحيته خلال 10 دقائق.</p><p>إذا لم تطلب هذا، يُرجى تجاهل هذا البريد الإلكتروني.</p></div>`
            : `<p>Your RIO sign-in verification code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you didn't request this, ignore this email.</p>`,
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

  /**
   * The code a citizen needs to submit a public survey response.
   *
   * Separate from sendLoginOtpEmail because the wording is not
   * interchangeable: a citizen is not signing in to anything, and telling
   * them they are invites them to look for an account they do not have.
   * Same soft-fail contract as every other send here — never throws, so a
   * mail outage cannot strand a respondent mid-survey.
   */
  async sendCitizenOtpEmail(email: string, code: string): Promise<boolean> {
    // The one send that may go through the second account. Both fall back
    // together: an unset SURVEY_OTP_MAIL_PROVIDER, or one whose credentials
    // were incomplete at boot, leaves surveyOtpClient undefined and this
    // behaves exactly as every other send method.
    const client = this.surveyOtpClient ?? this.client;
    const from = this.surveyOtpClient ? (this.surveyOtpFrom as string) : this.config.mailFrom;
    if (!client) return false;
    try {
      const { error } = await client.emails.send({
        from,
        to: email,
        subject: 'Your RIO survey verification code',
        text: `Your verification code is ${code}. Enter it to submit your survey response. It expires in 10 minutes. If you did not request this, ignore this email.`,
        html: `<p>Your verification code is <strong>${code}</strong>. Enter it to submit your survey response.</p><p>It expires in 10 minutes. If you did not request this, ignore this email.</p>`,
      });
      if (error) {
        this.logger.error(`Failed to email citizen OTP code to ${redactEmail(email)}: ${error.name} ${error.message}`);
        this.recordSendFailure('citizen_otp', redactEmail(email), {
          provider: this.surveyOtpProvider ?? this.config.mailProvider,
          providerError: `${error.name}: ${error.message}`,
        });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email citizen OTP code to ${redactEmail(email)}`, err as Error);
      this.recordSendFailure(
        'citizen_otp',
        redactEmail(email),
        { provider: this.surveyOtpProvider ?? this.config.mailProvider },
        err,
      );
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
        subject: `استفسار جديد في RIO — ${enquiry.name} (${enquiry.region})`,
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
        subject: `رابط استبيان: ${input.needTitleAr}`,
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
        subject: `تذكير: لم تكتمل إجابتك على استبيان ${input.needTitleAr}`,
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
   * RIO-FR-014 (client Q28, confirmed 2026-08-30) — "in-app plus email: to
   * the owner when a request arrives, to the requester when it is
   * decided." The in-app half already existed (SharingAlertsService); this
   * is the previously-missing email half, for both Study Sharing and Report
   * Sharing (SharingService.create / ReportSharingService.create). Always
   * Arabic — same system-notification-email default as temp-password/
   * password-reset (Ganesh's brief, 2026-09-29). Draft Arabic copy, pending
   * translation review like every other new string in this pass.
   */
  async sendSharingRequestCreated(
    email: string,
    input: Omit<SharingNotificationEmailInput, 'reviewUrl'>,
  ): Promise<boolean> {
    if (!this.client) return false;
    const withUrl = { ...input, reviewUrl: `${this.config.corsOrigin}/ar/sharing` };
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject: 'طلب مشاركة جديد في RIO',
        text: sharingRequestCreatedText(withUrl),
        html: sharingRequestCreatedHtml(withUrl),
      });
      if (error) {
        this.logger.error(`Failed to email sharing request created to ${redactEmail(email)}: ${error.name} ${error.message}`);
        this.recordSendFailure('sharing_request_created', redactEmail(email), { providerError: `${error.name}: ${error.message}` });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email sharing request created to ${redactEmail(email)}`, err as Error);
      this.recordSendFailure('sharing_request_created', redactEmail(email), {}, err);
      return false;
    }
  }

  /** The other half of RIO-FR-014's Q28 — the requester learning the outcome. */
  async sendSharingRequestDecided(
    email: string,
    input: Omit<SharingNotificationEmailInput, 'reviewUrl'> & {
      status: 'approved' | 'rejected';
      decisionNote?: string | null;
    },
  ): Promise<boolean> {
    if (!this.client) return false;
    const withUrl = { ...input, reviewUrl: `${this.config.corsOrigin}/ar/sharing` };
    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: email,
        subject:
          input.status === 'approved' ? 'تمت الموافقة على طلب المشاركة' : 'تم رفض طلب المشاركة',
        text: sharingRequestDecidedText(withUrl),
        html: sharingRequestDecidedHtml(withUrl),
      });
      if (error) {
        this.logger.error(`Failed to email sharing request decided to ${redactEmail(email)}: ${error.name} ${error.message}`);
        this.recordSendFailure('sharing_request_decided', redactEmail(email), { providerError: `${error.name}: ${error.message}` });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to email sharing request decided to ${redactEmail(email)}`, err as Error);
      this.recordSendFailure('sharing_request_decided', redactEmail(email), {}, err);
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
    // Arabic by default like every other system email (Jagan, 2026-09-29).
    // The run id, timestamp and pg_dump error stay as-is — they're technical
    // values an administrator searches for, not copy.
    const kindAr = BACKUP_KIND_AR[input.kind] ?? input.kind;
    const subject = `فشل النسخ الاحتياطي في RIO — ${kindAr}`;
    // The error text is included in full. It is written by pg_dump or by this
    // module, carries no tenant data, and the first question an administrator
    // asks is "why" — sending them to a screen to find out wastes the alert.
    const text =
      `فشل النسخ الاحتياطي (${kindAr}).\n\n` +
      `وقت البدء: ${when}\n` +
      `معرّف التشغيل: ${input.runId}\n\n` +
      `الخطأ:\n${input.error}\n\n` +
      `إلى أن تُحل هذه المشكلة، لا توجد لدى المنصة نسخة احتياطية حديثة (${kindAr}).\n` +
      `راجع: إدارة النظام ← النسخ الاحتياطي.`;

    try {
      const { error } = await this.client.emails.send({
        from: this.config.mailFrom,
        to: this.config.mailFrom,
        // BCC so one administrator cannot see the others addresses.
        bcc: recipients,
        subject,
        text,
        html: backupFailureHtml({ ...input, kind: kindAr, when }),
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
      // provider first so a caller that sent through a different account
      // (sendCitizenOtpEmail) can name it; every other caller omits it.
      context: { provider: this.config.mailProvider, ...context, kind, recipient },
    });
  }
}

interface SurveyLinkEmailInput {
  needTitle: string;
  /** The Need's title resolved into Arabic — same string as `needTitle`
   * when translation wasn't needed or failed (see
   * PublicSurveysService.shareLinkByEmail), never blank. */
  needTitleAr: string;
  linkLabel: string;
  publicUrl: string;
  qrCodePng: Buffer;
}

// Bilingual — Arabic first, matching the link itself (UAT-02: every
// generated public-survey link forces `/ar/...`, since the citizen
// respondent is expected to be an Arabic speaker; English stays reachable
// as an in-page toggle once they open it). The surrounding email COPY was
// English-only until now (client-reported, UAT-11) even though the link it
// points at already opens in Arabic — this closes that gap for the one
// email that goes to an arbitrary citizen-supplied address, not a
// registered user with any stored language preference to read instead.
// Draft wording: this is new citizen-facing copy and should go through the
// same translation-review process as the rest of the citizen survey text
// before being treated as final.
function surveyLinkText({ needTitleAr, publicUrl }: SurveyLinkEmailInput): string {
  return (
    `تم إرسال رابط استبيان لك بخصوص "${needTitleAr}".\n\n` +
    `فتح الاستبيان: ${publicUrl}\n\n` +
    `يمكنك أيضًا مسح رمز QR المرفق باستخدام كاميرا الهاتف لفتحه مباشرة.`
  );
}

// Same table-based layout + inline styles as the other templates in this
// file (Gmail/Outlook strip <style> blocks and most CSS layout properties).
// The QR code is referenced via cid: (see sendSurveyLink's attachments),
// not a data: URI — data: URIs in <img src> are stripped by several major
// email clients (Gmail included), cid: embedding is the reliable path.
function surveyLinkHtml({ needTitleAr, publicUrl }: SurveyLinkEmailInput): string {
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
                <!-- Arabic only, matching every other system-triggered
                     email (Ganesh's brief, 2026-09-29) and the link itself
                     (UAT-02). Arabic wording is a draft pending translation
                     review. -->
                <div dir="rtl" lang="ar" style="text-align:right;">
                  <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${esc(needTitleAr)}</h1>
                  <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#4b5563;">
                    تم إرسال رابط استبيان لك. افتحه مباشرة، أو امسح
                    رمز QR أدناه باستخدام كاميرا الهاتف.
                  </p>
                  <table role="presentation" cellpadding="0" cellspacing="0" align="right" style="margin-bottom:24px;">
                    <tr>
                      <td style="border-radius:8px;background-color:${PRIMARY};">
                        <a href="${esc(publicUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                          فتح الاستبيان
                        </a>
                      </td>
                    </tr>
                  </table>
                  <table role="presentation" cellpadding="0" cellspacing="0" align="right" bgcolor="${SECONDARY_TINT}" class="email-accent" style="background-color:${SECONDARY_TINT};border-radius:8px;">
                    <tr>
                      <td style="padding:12px;">
                        <img src="cid:survey-qr-code" alt="رمز QR لرابط الاستبيان" width="180" height="180" style="display:block;border-radius:4px;" />
                      </td>
                    </tr>
                  </table>
                </div>
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

// Arabic only, like every other system email (Jagan, 2026-09-29: "all mail
// should be Arabic by default"). Draft Arabic copy pending translation review.
function contactRequestText({ orgName, name, email, region, purpose }: ContactEnquiryInput): string {
  return (
    `استفسار تواصل جديد لـ ${orgName}\n\n` +
    `الاسم: ${name}\n` +
    `البريد الإلكتروني: ${email}\n` +
    `المنطقة: ${region}\n\n` +
    `الغرض:\n${purpose}\n\n` +
    `رُدّ على هذا البريد مباشرةً للتواصل مع ${name}.`
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
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;">${esc(label)}</p>
                      <p style="margin:0 0 16px;font-size:14px;color:#111827;font-weight:600;">${esc(value)}</p>`;

  return `
<!doctype html>
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: '#145463' })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="#145463" class="email-header" style="background-color:#145463;padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <!-- Arabic only — see contactRequestText. -->
                <div dir="rtl" lang="ar" style="text-align:right;">
                  <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">استفسار تواصل جديد</h1>
                  <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#4b5563;">
                    تواصل أحد الأشخاص مع ${esc(orgName)} من خلال صفحة تسجيل
                    الدخول في RIO.
                  </p>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
                    <tr>
                      <td style="padding:16px 20px;">${row('الاسم', name)}${row('البريد الإلكتروني', email)}${row('المنطقة', region)}
                        <p style="margin:0 0 4px;font-size:12px;color:#6b7280;">الغرض</p>
                        <p style="margin:0;font-size:14px;line-height:1.8;color:#111827;white-space:pre-wrap;">${esc(purpose)}</p>
                      </td>
                    </tr>
                  </table>
                  <table role="presentation" cellpadding="0" cellspacing="0" align="right">
                    <tr>
                      <td style="border-radius:8px;background-color:#145463;">
                        <a href="mailto:${esc(email)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                          الرد على ${esc(name)}
                        </a>
                      </td>
                    </tr>
                  </table>
                </div>
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

function passwordResetText({ resetUrl }: PasswordResetEmailInput, locale: SupportedLocale): string {
  if (locale === 'ar') {
    return (
      `تلقينا طلبًا لإعادة تعيين كلمة مرور RIO الخاصة بك.\n\n` +
      `إعادة تعيين كلمة المرور: ${resetUrl}\n\n` +
      `تنتهي صلاحية هذا الرابط خلال 30 دقيقة. إذا لم تطلب ذلك، يمكنك تجاهل هذا البريد الإلكتروني بأمان.`
    );
  }
  return (
    `We received a request to reset your RIO password.\n\n` +
    `Reset your password: ${resetUrl}\n\n` +
    `This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.`
  );
}

function passwordResetHtml(
  { resetUrl }: PasswordResetEmailInput,
  locale: SupportedLocale,
): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ar = locale === 'ar';

  return `
<!doctype html>
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: '#145463' })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="#145463" class="email-header" style="background-color:#145463;padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;" dir="${ar ? 'rtl' : 'ltr'}" lang="${ar ? 'ar' : 'en'}">
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${ar ? 'إعادة تعيين كلمة المرور' : 'Reset your password'}</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563;">
                  ${
                    ar
                      ? 'تلقينا طلبًا لإعادة تعيين كلمة مرور RIO الخاصة بك. اضغط على الزر أدناه لاختيار كلمة مرور جديدة. تنتهي صلاحية هذا الرابط خلال 30 دقيقة.'
                      : "We received a request to reset your RIO password. Click the button below to choose a new one. This link expires in 30 minutes."
                  }
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background-color:#145463;">
                      <a href="${esc(resetUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        ${ar ? 'إعادة تعيين كلمة المرور' : 'Reset Password'}
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  ${ar ? 'إذا لم تطلب ذلك، يمكنك تجاهل هذا البريد الإلكتروني بأمان.' : "If you didn't request this, you can safely ignore this email."}
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

function temporaryPasswordText(
  { orgName, email, tempPassword, signInUrl }: TemporaryPasswordEmailInput,
  locale: SupportedLocale,
): string {
  if (locale === 'ar') {
    return (
      `مرحبًا بك في RIO، ${orgName}!\n\n` +
      `تم إنشاء حساب لكيانك. استخدم البيانات أدناه لتسجيل الدخول، ثم قم بتعيين كلمة المرور الخاصة بك.\n\n` +
      `مساحة العمل: ${orgName}\n` +
      `البريد الإلكتروني: ${email}\n` +
      `كلمة المرور المؤقتة: ${tempPassword}\n\n` +
      `تسجيل الدخول: ${signInUrl}\n\n` +
      `سيُطلب منك تغيير كلمة المرور هذه عند أول تسجيل دخول.`
    );
  }
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
function temporaryPasswordHtml(
  { orgName, email, tempPassword, signInUrl }: TemporaryPasswordEmailInput,
  locale: SupportedLocale,
): string {
  const ar = locale === 'ar';
  // Escapes text-content chars (&, <, >) and quote chars (", ') too, so a
  // value is safe in attribute context as well — signInUrl is interpolated
  // into href="...".
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  return `
<!doctype html>
<html>${lightModeEmailHead({ page: '#f4f5f7', card: '#ffffff', header: '#145463' })}
  <body class="email-page" style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" class="email-page" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="email-card" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td bgcolor="#145463" class="email-header" style="background-color:#145463;padding:24px 32px;">
                <span class="email-header-text" style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">RIO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;" dir="${ar ? 'rtl' : 'ltr'}" lang="${ar ? 'ar' : 'en'}">
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${ar ? `مرحبًا بك في RIO، ${esc(orgName)}!` : `Welcome to RIO, ${esc(orgName)}!`}</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563;">
                  ${
                    ar
                      ? 'تم إنشاء حساب لكيانك. استخدم البيانات أدناه لتسجيل الدخول، ثم سيُطلب منك تعيين كلمة المرور الخاصة بك.'
                      : "An account has been created for your organization. Use the credentials below to sign in, then you'll be asked to set your own password."
                  }
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">${ar ? 'مساحة العمل' : 'Workspace'}</p>
                      <p style="margin:0 0 16px;font-size:14px;color:#111827;font-weight:600;">${esc(orgName)}</p>
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">${ar ? 'البريد الإلكتروني' : 'Email'}</p>
                      <p style="margin:0 0 16px;font-size:14px;color:#111827;font-weight:600;">${esc(email)}</p>
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">${ar ? 'كلمة المرور المؤقتة' : 'Temporary password'}</p>
                      <p style="margin:0;font-size:14px;color:#111827;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(tempPassword)}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background-color:#145463;">
                      <a href="${esc(signInUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        ${ar ? 'تسجيل الدخول إلى RIO' : 'Sign in to RIO'}
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  ${
                    ar
                      ? 'سيُطلب منك تغيير كلمة المرور هذه عند أول تسجيل دخول. إذا لم تكن تتوقع هذا البريد الإلكتروني، يمكنك تجاهله بأمان.'
                      : "You'll be asked to change this password the first time you sign in. If you weren't expecting this email, you can safely ignore it."
                  }
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
  /** Same contract as SurveyLinkEmailInput.needTitleAr — the Need title
   * resolved into Arabic, falling back to `needTitle`, never blank. */
  needTitleAr: string;
  publicUrl: string;
}

// Arabic only, like every other system-triggered email (Jagan, 2026-09-29:
// "all mail should be Arabic by default"). Draft Arabic copy pending
// translation review, same as surveyLinkText.
function surveyReminderText({ needTitleAr, publicUrl }: SurveyReminderEmailInput): string {
  return (
    `لقد بدأت الإجابة على استبيان "${needTitleAr}" ولكن لم تُكمله.\n\n` +
    `افتح الاستبيان مرة أخرى: ${publicUrl}\n\n` +
    `لم تُحفظ إجاباتك السابقة، لذلك ستبدأ الأسئلة من البداية. ` +
    `لا تُحتسب الإجابة إلا بعد إرسالها.\n\n` +
    `إذا كنت لا ترغب في المشاركة، فلا يلزمك أي إجراء — لن نرسل لك تذكيرًا آخر بعد هذه الرسالة.`
  );
}

function surveyReminderHtml({ needTitleAr, publicUrl }: SurveyReminderEmailInput): string {
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
                <!-- Arabic only — see surveyReminderText. -->
                <div dir="rtl" lang="ar" style="text-align:right;">
                  <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${esc(needTitleAr)}</h1>
                  <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#4b5563;">
                    لقد بدأت الإجابة على هذا الاستبيان ولكن لم تُكمله. لم تُحفظ
                    إجاباتك السابقة، لذلك ستبدأ الأسئلة من البداية &mdash;
                    لا تُحتسب الإجابة إلا بعد إرسالها.
                  </p>
                  <table role="presentation" cellpadding="0" cellspacing="0" align="right" style="margin-bottom:24px;">
                    <tr>
                      <td style="border-radius:8px;background-color:${PRIMARY};">
                        <a href="${esc(publicUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                          إكمال الاستبيان
                        </a>
                      </td>
                    </tr>
                  </table>
                  <p style="clear:both;margin:0;font-size:12px;line-height:1.8;color:#6b7280;">
                    إذا كنت لا ترغب في المشاركة، فلا يلزمك أي إجراء.
                  </p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const BACKUP_KIND_AR: Record<string, string> = {
  database: 'قاعدة البيانات',
  attachments: 'المرفقات',
};

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
        <td dir="rtl" lang="ar" style="padding:24px;text-align:right;">
          <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#b91c1c;">
            فشل النسخ الاحتياطي &mdash; ${esc(input.kind)}
          </p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:#374151;">
            إلى أن تُحل هذه المشكلة، لا توجد لدى المنصة نسخة احتياطية حديثة (${esc(input.kind)}).
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;font-size:13px;color:#374151;">
            <tr><td style="padding:4px 0;color:#6b7280;">وقت البدء</td><td dir="ltr" style="padding:4px 0;text-align:right;">${esc(input.when)}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;">معرّف التشغيل</td><td dir="ltr" style="padding:4px 0;font-family:monospace;text-align:right;">${esc(input.runId)}</td></tr>
          </table>
          <!-- The pg_dump error itself is English/technical; kept LTR so it stays readable. -->
          <pre dir="ltr" style="margin:0 0 16px;padding:12px;background:#f3f4f6;border-radius:8px;font-size:12px;line-height:1.5;color:#111827;white-space:pre-wrap;word-break:break-word;text-align:left;">${esc(input.error)}</pre>
          <p style="margin:0;font-size:12px;color:#6b7280;">
            إدارة النظام &larr; النسخ الاحتياطي
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

interface SharingNotificationEmailInput {
  /** e.g. "the study \"Water Access Assessment\"" or "the report \"...\"" — the
   * kind of entity (study vs report) is baked into this string rather than
   * passed as a separate flag, since Study Sharing and Report Sharing are
   * two distinct backend modules (see ReportSharingService's own comment on
   * why they're not unified) sharing one email shape. */
  entityLabel: string;
  /** The requesting org's name (on creation) or the owning org's name (on
   * decision) — whichever org the RECIPIENT needs to know about. */
  otherOrgName: string;
  /** Deep link straight to the Sharing screen (client-requested: a button
   * that takes the reader into the app to actually act on the request,
   * not just a bare notification). `/ar/` prefixed like every other
   * system email's link — Arabic by default, same reasoning as the
   * survey-link URL. */
  reviewUrl: string;
}

function sharingRequestCreatedText({
  entityLabel,
  otherOrgName,
  reviewUrl,
}: SharingNotificationEmailInput): string {
  return (
    `تلقيت طلب مشاركة جديدًا بخصوص ${entityLabel} من ${otherOrgName}.\n\n` +
    `مراجعة الطلب: ${reviewUrl}`
  );
}

function sharingRequestCreatedHtml(input: SharingNotificationEmailInput): string {
  const esc = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Same brand teal as the survey-link email (src/styles/tokens.css
  // --primary), not this file's generic #111827 neutral — every
  // system-triggered email should look like it came from the same product.
  const PRIMARY = '#145463';
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
              <td style="padding:32px;" dir="rtl" lang="ar">
                <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">طلب مشاركة جديد</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#4b5563;">
                  تلقيت طلب مشاركة جديدًا بخصوص ${esc(input.entityLabel)} من ${esc(input.otherOrgName)}.
                  يمكنك مراجعة الطلب والموافقة عليه أو رفضه من داخل منصة RIO.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" align="right">
                  <tr>
                    <td style="border-radius:8px;background-color:${PRIMARY};">
                      <a href="${esc(input.reviewUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        مراجعة الطلب
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

function sharingRequestDecidedText({
  entityLabel,
  otherOrgName,
  reviewUrl,
  status,
  decisionNote,
}: SharingNotificationEmailInput & { status: 'approved' | 'rejected'; decisionNote?: string | null }): string {
  const verdict = status === 'approved' ? 'تمت الموافقة على' : 'تم رفض';
  const base = `${verdict} طلب المشاركة الخاص بك بخصوص ${entityLabel} من ${otherOrgName}.`;
  const withNote = decisionNote ? `${base}\n\nملاحظة: ${decisionNote}` : base;
  return `${withNote}\n\nفتح في RIO: ${reviewUrl}`;
}

function sharingRequestDecidedHtml(
  input: SharingNotificationEmailInput & { status: 'approved' | 'rejected'; decisionNote?: string | null },
): string {
  const esc = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const approved = input.status === 'approved';
  const verdict = approved ? 'تمت الموافقة على طلبك' : 'تم رفض طلبك';
  // Same brand teal header regardless of outcome (consistent branding,
  // matching every other system-triggered email) — the rejection itself is
  // still legible from the verdict heading's own red text below, not from
  // recoloring the whole header.
  const PRIMARY = '#145463';
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
              <td style="padding:32px;" dir="rtl" lang="ar">
                <h1 style="margin:0 0 12px;font-size:20px;color:${approved ? '#111827' : '#b91c1c'};">${verdict}</h1>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:#4b5563;">
                  ${verdict} بخصوص ${esc(input.entityLabel)} من ${esc(input.otherOrgName)}.
                </p>
                ${
                  input.decisionNote
                    ? `<p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6b7280;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;">${esc(input.decisionNote)}</p>`
                    : '<div style="margin-bottom:24px;"></div>'
                }
                <table role="presentation" cellpadding="0" cellspacing="0" align="right">
                  <tr>
                    <td style="border-radius:8px;background-color:${PRIMARY};">
                      <a href="${esc(input.reviewUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        فتح في RIO
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

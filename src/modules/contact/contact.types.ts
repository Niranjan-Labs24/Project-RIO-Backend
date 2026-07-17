/** Minimal public projection of an organisation: enough to populate the
*  contact form's picker, and deliberately nothing more (no registration
*  number, email, or activity status). */
export interface PublicOrganizationOption {
  id: string;
  name: string;
}

export interface ContactSubmissionResult {
  /** False when no SMTP transport is configured — the enquiry is accepted and
   *  logged, but nothing was actually delivered. */
  delivered: boolean;
  /** How many recipients the enquiry was addressed to. */
  recipientCount: number;
}
 
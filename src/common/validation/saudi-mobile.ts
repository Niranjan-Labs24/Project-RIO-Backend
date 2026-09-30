// UAT-12 — Saudi mobile number validation + canonical form.
//
// A Saudi mobile is a 9-digit subscriber number starting with 5, written
// locally as 05XXXXXXXX / 5XXXXXXXX or internationally as +9665XXXXXXXX /
// 009665XXXXXXXX / 9665XXXXXXXX. All of those are the same phone, so they
// normalize to one stored form (E.164, "+9665XXXXXXXX") — the form the
// frontend's PhoneNumberInput emits and the OTP sign-in lookup matches on.
const SAUDI_MOBILE = /^(?:\+966|00966|966|0)?(5\d{8})$/;

/** Canonical "+9665XXXXXXXX", or null when `input` isn't a Saudi mobile. */
export function toSaudiMobileE164(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, '');
  const match = SAUDI_MOBILE.exec(compact);
  return match ? `+966${match[1]}` : null;
}

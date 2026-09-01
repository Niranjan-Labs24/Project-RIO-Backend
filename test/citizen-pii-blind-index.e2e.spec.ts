import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient } from '../src/generated/prisma';
import { decryptPii, encryptPii, computeBlindIndex, isEncrypted } from '../src/modules/citizen/citizen-pii.crypto';
import { ownerClient } from './db.helper';

// GAP-03/AD-17 DB-gated proof: SurveyResponse.contact/.mobile are now
// AES-256-GCM (authenticated, random IV) instead of deterministic AES-CBC,
// so dedup/uniqueness moved to the separate contact_blind_index/
// mobile_blind_index columns. Runs against the real Docker DB (owner
// connection — tenant tables are FORCE-RLS, so writes run inside a
// transaction that sets app.current_org_id, mirroring
// tenant-isolation.e2e.spec.ts).
describe('SurveyResponse PII: GCM ciphertext + blind-index dedup (GAP-03)', () => {
  let owner: PrismaClient;
  const orgId = uuidv7();
  const studyId = uuidv7();
  const needId = uuidv7();
  const surveyLinkId = uuidv7();
  const userId = uuidv7();
  const run = Date.now();
  const email = `gap03-${run}@example.org`;

  const ENCRYPTION_KEY = Buffer.alloc(32, 21).toString('base64');
  const BLIND_INDEX_KEY = Buffer.alloc(32, 22).toString('base64');

  async function setOrg(tx: { $executeRaw: PrismaClient['$executeRaw'] }): Promise<void> {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
  }

  beforeAll(async () => {
    owner = ownerClient();
    await owner.$transaction(async (tx) => {
      await setOrg(tx);
      await tx.$executeRaw`INSERT INTO organisations (id, name, updated_at) VALUES (${orgId}::uuid, ${'GAP-03 Org'}, now())`;
      await tx.$executeRaw`INSERT INTO users (id, org_id, role_id, name, email, status, updated_at)
        VALUES (${userId}::uuid, ${orgId}::uuid, 'role_ngo_admin', ${'GAP-03 Admin'}, ${email}, 'invited'::"UserStatus", now())`;
      await tx.$executeRaw`INSERT INTO studies (id, org_id, title, cycle_number, created_by, updated_at)
        VALUES (${studyId}::uuid, ${orgId}::uuid, ${'GAP-03 Study'}, 1, ${userId}::uuid, now())`;
      await tx.$executeRaw`INSERT INTO needs (id, study_id, org_id, title, statement, source, created_by, updated_at)
        VALUES (${needId}::uuid, ${studyId}::uuid, ${orgId}::uuid, ${'GAP-03 Need'}, ${'Statement'}, 'manual_entry'::"NeedSource", ${userId}::uuid, now())`;
      await tx.$executeRaw`INSERT INTO public_survey_links (id, org_id, need_id, study_id, label, token, created_by)
        VALUES (${surveyLinkId}::uuid, ${orgId}::uuid, ${needId}::uuid, ${studyId}::uuid, ${'GAP-03 Link'}, ${`gap03-${run}`}, ${userId}::uuid)`;
    });
  });

  afterAll(async () => {
    await owner.$transaction(async (tx) => {
      await setOrg(tx);
      await tx.$executeRaw`DELETE FROM survey_responses WHERE need_id = ${needId}::uuid`;
      await tx.$executeRaw`DELETE FROM public_survey_links WHERE id = ${surveyLinkId}::uuid`;
      await tx.$executeRaw`DELETE FROM needs WHERE id = ${needId}::uuid`;
      await tx.$executeRaw`DELETE FROM studies WHERE id = ${studyId}::uuid`;
      await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}::uuid`;
      await tx.$executeRaw`DELETE FROM organisations WHERE id = ${orgId}::uuid`;
    });
    await owner.$disconnect();
  });

  // Mirrors CitizenService.normalizeContact.
  function normalizeContact(contact: string): string {
    return contact.trim().toLowerCase();
  }

  async function submit(rawContact: string): Promise<{ id: string; contact: string; contactBlindIndex: string }> {
    const normalized = normalizeContact(rawContact);
    const contact = encryptPii(normalized, ENCRYPTION_KEY);
    const contactBlindIndex = computeBlindIndex(normalized, BLIND_INDEX_KEY);
    return owner.$transaction(async (tx) => {
      await setOrg(tx);
      return tx.surveyResponse.create({
        data: {
          orgId, needId, studyId, surveyLinkId,
          contact, contactBlindIndex,
          answers: {},
        },
        select: { id: true, contact: true, contactBlindIndex: true },
      });
    });
  }

  it('stores GCM ciphertext (starts "gcm.v1:") and decryptPii recovers the original plaintext', async () => {
    const row = await submit('Citizen.One@Example.com');
    expect(row.contact.startsWith('gcm.v1:')).toBe(true);
    expect(isEncrypted(row.contact)).toBe(true);
    expect(decryptPii(row.contact, ENCRYPTION_KEY)).toBe('citizen.one@example.com');
  });

  it('two submissions of the SAME contact never collide on ciphertext (random IV) but DO collide on the blind index', async () => {
    const a = await submit('Citizen.Two@Example.com');
    // Second encryption of the identical normalized value — GCM's random IV
    // must make this ciphertext different from the first, even though both
    // decrypt to the same plaintext.
    const secondCiphertext = encryptPii(normalizeContact('Citizen.Two@Example.com'), ENCRYPTION_KEY);
    expect(secondCiphertext).not.toBe(a.contact);
    expect(decryptPii(secondCiphertext, ENCRYPTION_KEY)).toBe('citizen.two@example.com');

    // But the blind index — computed from the same normalized value — is
    // identical, which is what a real second submission would collide on.
    const secondBlindIndex = computeBlindIndex(normalizeContact('Citizen.Two@Example.com'), BLIND_INDEX_KEY);
    expect(secondBlindIndex).toBe(a.contactBlindIndex);
  });

  it('a second submission with the same contact (different casing/whitespace) is rejected as a duplicate via the blind index (@@unique violation)', async () => {
    await submit('  Citizen.Three@Example.com  ');
    // Different casing/whitespace, same normalized identity — must hash to
    // the same blind index and therefore violate @@unique([needId, contactBlindIndex]).
    await expect(submit('CITIZEN.THREE@example.com')).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('two different contacts never collide on the blind index', async () => {
    const a = await submit('Citizen.Four@Example.com');
    const b = await submit('Citizen.Five@Example.com');
    expect(a.contactBlindIndex).not.toBe(b.contactBlindIndex);
  });
});

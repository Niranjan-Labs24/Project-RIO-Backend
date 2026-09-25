import { describe, expect, it, vi } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { ContactService } from './contact.service';

function setup() {
  const tx = makeFakeTx();
  const tenant = { runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx) };
  const mailer = { sendContactRequest: vi.fn().mockResolvedValue(true) };
  return { tx, mailer, svc: new ContactService(tenant as never, mailer as never) };
}
const dto = {
  organizationId: 'o1',
  name: 'N',
  email: 'e@x.org',
  region: 'R',
  purpose: 'P',
} as never;
const code = (c: string) =>
  expect.objectContaining({ response: { error: expect.objectContaining({ code: c }) } });

describe('ContactService', () => {
  it('lists only id and name of active organisations', async () => {
    const { svc, tx } = setup();
    tx.organisation.findMany.mockResolvedValue([{ id: 'o1', name: 'Org', secret: 'x' }]);
    expect(await svc.listOrganizations()).toEqual([{ id: 'o1', name: 'Org' }]);
  });

  it('sends the enquiry to active research officers', async () => {
    const { svc, tx, mailer } = setup();
    tx.organisation.findFirst.mockResolvedValue({ id: 'o1', name: 'Org' });
    tx.user.findMany.mockResolvedValue([{ email: 'a@x.org' }, { email: 'b@x.org' }]);
    expect(await svc.submit(dto)).toEqual({ delivered: true, recipientCount: 2 });
    expect(mailer.sendContactRequest.mock.calls[0]![0]).toEqual(['a@x.org', 'b@x.org']);
  });

  it('falls back to admins when there is no research officer', async () => {
    const { svc, tx } = setup();
    tx.organisation.findFirst.mockResolvedValue({ id: 'o1', name: 'Org' });
    tx.user.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ email: 'admin@x.org' }]);
    expect((await svc.submit(dto)).recipientCount).toBe(1);
  });

  it('fails loudly for an unknown org, no recipient, or a failed delivery', async () => {
    const { svc, tx, mailer } = setup();
    await expect(svc.submit(dto)).rejects.toThrow(code('ORG_NOT_FOUND'));
    tx.organisation.findFirst.mockResolvedValue({ id: 'o1', name: 'Org' });
    await expect(svc.submit(dto)).rejects.toThrow(code('NO_CONTACT_RECIPIENT'));
    tx.user.findMany.mockResolvedValue([{ email: 'a@x.org' }]);
    mailer.sendContactRequest.mockResolvedValue(false);
    await expect(svc.submit(dto)).rejects.toThrow(code('CONTACT_DELIVERY_FAILED'));
  });
});

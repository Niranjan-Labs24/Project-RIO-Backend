import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import type { CreateNoteDto, NoteView } from './notes.contract';

interface NoteRow {
  id: string;
  body: string;
  createdAt: Date;
}

function toView(row: NoteRow): NoteView {
  return { id: row.id, body: row.body, createdAt: row.createdAt.toISOString() };
}

@Injectable()
export class NotesRepository {
  constructor(private readonly tenant: TenantPrismaService) {}

  async list(): Promise<NoteView[]> {
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.note.findMany({ orderBy: { createdAt: 'desc' } }),
    );
    return (rows as NoteRow[]).map(toView);
  }

  async create(dto: CreateNoteDto): Promise<NoteView> {
    // org_id is supplied by the RLS/session context, never by the client payload.
    const row = await this.tenant.runInOrgContext(
      (tx) =>
        tx.$queryRaw`
        INSERT INTO notes (org_id, body)
        VALUES (current_setting('app.current_org_id', true)::uuid, ${dto.body})
        RETURNING id, body, created_at AS "createdAt"
      `,
    );
    const created = (row as NoteRow[])[0];
    if (!created) {
      throw new Error('Note insert returned no row');
    }
    return toView(created);
  }
}

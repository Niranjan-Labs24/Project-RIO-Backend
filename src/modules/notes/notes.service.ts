import { Injectable } from '@nestjs/common';
import { NotesRepository } from './notes.repository';
import type { CreateNoteDto, NoteView } from './notes.contract';

@Injectable()
export class NotesService {
  constructor(private readonly repo: NotesRepository) {}

  list(): Promise<NoteView[]> {
    return this.repo.list();
  }

  create(dto: CreateNoteDto): Promise<NoteView> {
    return this.repo.create(dto);
  }
}

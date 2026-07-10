import { Body, Controller, Get, Post } from '@nestjs/common';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreateNoteBody, type CreateNoteDto, type NoteView } from './notes.contract';
import { NotesService } from './notes.service';

@Controller('notes')
export class NotesController {
  constructor(private readonly service: NotesService) {}

  @Get()
  list(): Promise<NoteView[]> {
    return this.service.list();
  }

  @Post()
  create(@Body(new TypeBoxValidationPipe(CreateNoteBody)) body: CreateNoteDto): Promise<NoteView> {
    return this.service.create(body);
  }
}

import { RateLimit } from "../../common/guards/rate-limit.guard";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { BadRequestException, Controller, Get, Param } from "@nestjs/common";
import { Public } from "../../auth/public.decorator";
import { PublicArchiveService } from "./public-archive.service";
import type {
  PublicArchiveDetail,
  PublicArchiveKind,
  PublicArchiveResponse,
  PublicDocumentResponse,
} from "./public-archive.types";

/** Live studies are absent by design, so `/public/archive/study/<id>` is a
 *  bad request rather than a 404 — there is no such kind on this API at all.
 *  See PublicArchiveKind. */
const KINDS: readonly PublicArchiveKind[] = ["report", "historical"];

/**
 * RIO-DATA-002 — the archive, open to anyone with the link.
 *
 * Three reads and nothing else: the list, one entry opened, and an uploaded
 * document turned into rows and text. All three are GETs that return JSON,
 * and all three cover released reports and archived prior studies only.
 *
 * None of them streams a file, which is the point the client asked for on
 * 2026-09-23: a reader can see a report and a spreadsheet in full and still
 * has nothing to save, because no endpoint here hands over bytes. `/document`
 * is the one to watch — it is named like a file route and is not one, and
 * turning it into one would quietly undo the whole feature.
 *
 * `@Public()` sits on the class, so adding a method here publishes it to the
 * open internet by default. Anything that should not be public belongs in
 * ArchiveController, which is permission-gated, not in this file. In
 * particular: never add a route that resolves a storage key, and never accept
 * a body.
 */
@Public()
@Controller("public/archive")
export class PublicArchiveController {
  constructor(private readonly publicArchive: PublicArchiveService) {}

  @Get()
  list(): Promise<PublicArchiveResponse> {
    return this.publicArchive.list();
  }

  /** Declared before `:kind/:id` for readability; the three-segment path
   *  could not be captured by it in any case. */
  // Parsing a stored PDF/spreadsheet costs far more than the request itself, so this
  // route gets its own, tighter ceiling than the default 300 reads a minute.
  @RateLimit(60, 60)
  @Get("historical/:id/document")
  document(@Param("id", new UuidParamPipe()) id: string): Promise<PublicDocumentResponse> {
    return this.publicArchive.document(id);
  }

  @Get(":kind/:id")
  detail(@Param("kind") kind: string, @Param("id", new UuidParamPipe()) id: string): Promise<PublicArchiveDetail> {
    // Checked against the literal list rather than cast, so a typo in the URL
    // cannot reach the service as an unhandled kind.
    if (!KINDS.includes(kind as PublicArchiveKind)) {
      throw new BadRequestException("Unknown entry type");
    }
    return this.publicArchive.detail(kind as PublicArchiveKind, id);
  }
}

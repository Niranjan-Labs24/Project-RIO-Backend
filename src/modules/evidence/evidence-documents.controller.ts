import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { RequirePermission } from "../../common/guards/permission.guard";
import { EvidenceDocumentsService } from "./evidence-documents.service";
import { DocumentSummaryService, DocumentSummaryOutputJson } from "./document-summary.service";

@Controller("studies/:studyId/evidence-documents")
export class EvidenceDocumentsController {
  constructor(
    private readonly documentsService: EvidenceDocumentsService,
    private readonly summaryService: DocumentSummaryService,
  ) {}

  @Post()
  @RequirePermission("dataCollection", "create")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
    }),
  )
  async upload(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    if (!file) {
      throw new BadRequestException({
        error: { code: "NO_FILE", message: "Document file is required." },
      });
    }
    if (!body.title || !body.documentType || !body.sourceReferenceId || !body.collectedDate) {
      throw new BadRequestException({
        error: { code: "MISSING_FIELDS", message: "Title, documentType, sourceReferenceId, and collectedDate are required." },
      });
    }

    return this.documentsService.uploadDocument({
      studyId,
      title: body.title,
      documentType: body.documentType,
      sourceReferenceId: body.sourceReferenceId,
      collectedDate: body.collectedDate,
      description: body.description,
      linkedNeedId: body.linkedNeedId,
      linkedDomainId: body.linkedDomainId,
      linkedKpiId: body.linkedKpiId,
      fileName: file.originalname,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
    });
  }

  @Get()
  @RequirePermission("dataCollection", "read")
  async list(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Query("search") search?: string,
    @Query("documentType") documentType?: string,
    @Query("linkedDomainId") linkedDomainId?: string,
  ) {
    return this.documentsService.listDocuments({
      studyId,
      search,
      documentType,
      linkedDomainId,
    });
  }

  @Get(":id")
  @RequirePermission("dataCollection", "read")
  async getDetails(@Param("id", new UuidParamPipe()) id: string) {
    return this.documentsService.getDocumentDetails(id);
  }

  // Serves the original uploaded file so the UI can offer an "open document"
  // link next to the extracted text. Inline rather than attachment: the point
  // is to view the source, and browsers can render PDFs and images directly.
  @Get(":id/file")
  @RequirePermission("dataCollection", "read")
  async getFile(
    @Param("id", new UuidParamPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.documentsService.getDocumentFile(id);
    res.set({
      "Content-Type": file.fileType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(file.fileName)}"`,
      "Content-Length": String(file.buffer.length),
    });
    res.end(file.buffer);
  }

  @Patch(":id/inclusion")
  @RequirePermission("dataCollection", "write")
  async toggleInclusion(
    @Param("id", new UuidParamPipe()) id: string,
    @Body("isIncluded") isIncluded: boolean,
  ) {
    return this.documentsService.toggleInclusion(id, Boolean(isIncluded));
  }

  @Delete(":id")
  @HttpCode(200)
  @RequirePermission("dataCollection", "write")
  async deleteDocument(@Param("id", new UuidParamPipe()) id: string) {
    return this.documentsService.deleteDocument(id);
  }

  @Post(":id/summary/generate")
  @RequirePermission("aiReview", "write")
  async generateSummary(@Param("id", new UuidParamPipe()) id: string) {
    return this.summaryService.generateDocumentSummary(id);
  }

  @Put(":id/summary/:summaryId")
  @RequirePermission("aiReview", "write")
  async updateSummary(
    @Param("summaryId", new UuidParamPipe()) summaryId: string,
    @Body() body: DocumentSummaryOutputJson,
  ) {
    return this.summaryService.updateDraftSummary(summaryId, body);
  }

  @Post(":id/summary/:summaryId/confirm")
  @RequirePermission("aiReview", "write")
  async confirmSummary(@Param("summaryId", new UuidParamPipe()) summaryId: string) {
    return this.summaryService.confirmSummary(summaryId);
  }
}

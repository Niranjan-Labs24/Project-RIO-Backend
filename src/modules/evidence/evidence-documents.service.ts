import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import exceljs from "exceljs";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { AuditService } from "../audit/audit.service";
import { EvidenceStorageService } from "./evidence.storage.service";

export const SUPPORTED_EXTENSIONS = [".txt", ".docx", ".pdf", ".csv", ".xlsx"];

export interface CreateEvidenceDocumentPayload {
  studyId: string;
  title: string;
  documentType: string;
  sourceReferenceId: string;
  collectedDate: string;
  description?: string;
  linkedNeedId?: string;
  linkedDomainId?: string;
  linkedKpiId?: string;
  fileName: string;
  fileBuffer: Buffer;
  mimeType: string;
}

export interface ListEvidenceDocumentsQuery {
  studyId: string;
  search?: string;
  documentType?: string;
  linkedDomainId?: string;
}

const UNSUPPORTED_SCANNED_MSG =
  "Scanned PDFs and image-based documents are not supported in this version.";

// Storage (EvidenceStorageService) accepts these, but they hold no extractable
// text, so uploads of them fail parsing for a reason worth naming explicitly.
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const LEGACY_OFFICE_EXTENSIONS = new Set([".doc", ".xls"]);

@Injectable()
export class EvidenceDocumentsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: EvidenceStorageService,
    private readonly audit: AuditService,
  ) {}

  /** Extract plain text from supported document buffers. */
  async parseDocumentText(
    fileName: string,
    buffer: Buffer,
  ): Promise<{ text: string; chunkCount: number }> {
    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf("."));
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      // Storage accepts some types that carry no machine-readable text, so say
      // which situation this is rather than a bare "unsupported".
      const reason = IMAGE_EXTENSIONS.has(ext)
        ? "Images hold no text layer and optical character recognition is not available yet."
        : LEGACY_OFFICE_EXTENSIONS.has(ext)
          ? `Legacy ${ext} files are not readable. Re-save as ${ext === ".doc" ? ".docx" : ".xlsx"} and upload again.`
          : `Supported extensions: ${SUPPORTED_EXTENSIONS.join(", ")}.`;
      throw new BadRequestException({
        error: {
          code: "UNSUPPORTED_FILE_TYPE",
          message: `Text cannot be extracted from ${ext} files. ${reason}`,
        },
      });
    }

    let extractedText = "";

    if (ext === ".txt" || ext === ".csv") {
      // Strip a UTF-8 BOM so it does not end up as a stray character in the
      // first extracted word (common in Excel-exported CSVs).
      extractedText = buffer.toString("utf-8").replace(/^﻿/, "").trim();
    } else if (ext === ".xlsx") {
      const workbook = new exceljs.Workbook();
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const lines: string[] = [];
      workbook.eachSheet((worksheet) => {
        lines.push(`Sheet: ${worksheet.name}`);
        worksheet.eachRow((row) => {
          const rowValues = Array.isArray(row.values)
            ? row.values
                .slice(1)
                .map((v) => (v !== null && v !== undefined ? String(v) : ""))
                .join(" | ")
            : "";
          if (rowValues.trim()) lines.push(rowValues);
        });
      });
      extractedText = lines.join("\n").trim();
    } else if (ext === ".docx") {
      extractedText = await this.extractDocxText(buffer);
    } else if (ext === ".pdf") {
      extractedText = await this.extractPdfText(buffer);
    }

    if (!extractedText.trim()) {
      throw new BadRequestException({
        error: {
          code: "NO_TEXT_CONTENT",
          message: `"${fileName}" was read successfully but contains no text.`,
        },
      });
    }

    return { text: extractedText, chunkCount: Math.ceil(extractedText.length / 4000) };
  }

  /**
   * Extracts a PDF's text layer via pdf.js (through unpdf).
   *
   * A hand-rolled regex over the raw bytes cannot do this: virtually every real
   * PDF stores its content streams FlateDecode-compressed, so the text
   * operators are not visible until the streams are inflated, and TJ arrays
   * split words into kerned fragments that must be rejoined using font and
   * position data. pdf.js handles decompression, object streams, font
   * encodings and word spacing.
   *
   * Failure to decode and an absent text layer are reported separately —
   * "this is a scanned document" is only true of the latter.
   */
  private async extractPdfText(buffer: Buffer): Promise<string> {
    // unpdf is ESM-first; resolved lazily so the CJS build stays happy and the
    // pdf.js bundle is only loaded when a PDF is actually uploaded.
    const { extractText, getDocumentProxy } = await import("unpdf");

    let text: string;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const extracted = await extractText(pdf, { mergePages: true });
      text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
    } catch (err: unknown) {
      throw new BadRequestException({
        error: {
          code: "PARSING_FAILED",
          message: `The PDF could not be read: ${
            err instanceof Error ? err.message : "unrecognised or damaged file"
          }`,
        },
      });
    }

    const normalised = this.normaliseWhitespace(text);
    if (!normalised) {
      // Decoded fine, but there is no text layer at all — this is the genuine
      // scanned/image-only case.
      throw new BadRequestException({
        error: { code: "PDF_NO_TEXT_LAYER", message: UNSUPPORTED_SCANNED_MSG },
      });
    }
    return normalised;
  }

  /** Extracts .docx text via mammoth, which understands the full OOXML body. */
  private async extractDocxText(buffer: Buffer): Promise<string> {
    const mammoth = await import("mammoth");
    try {
      const result = await mammoth.extractRawText({ buffer });
      return this.normaliseWhitespace(result.value);
    } catch (err: unknown) {
      throw new BadRequestException({
        error: {
          code: "PARSING_FAILED",
          message: `The Word document could not be read: ${
            err instanceof Error ? err.message : "unrecognised or damaged file"
          }`,
        },
      });
    }
  }

  /** Collapses runs of whitespace while keeping paragraph breaks readable. */
  private normaliseWhitespace(text: string): string {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v ]+/g, " ")
      .replace(/ *\n{3,} */g, "\n\n")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  /** Split extracted text into ordered chunks (~4000 chars / ~1000 words per chunk). */
  splitChunks(text: string): { chunkIndex: number; chunkText: string; sectionReference: string }[] {
    const CHUNK_SIZE = 4000;
    const chunks: { chunkIndex: number; chunkText: string; sectionReference: string }[] = [];
    let start = 0;
    let index = 0;

    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length);
      const chunkText = text.substring(start, end).trim();
      chunks.push({
        chunkIndex: index,
        chunkText,
        sectionReference: `Section ${index + 1} (Chars ${start + 1}-${end})`,
      });
      start = end;
      index++;
    }

    return chunks;
  }

  async uploadDocument(payload: CreateEvidenceDocumentPayload) {
    const orgId = requireOrgId();
    const uploadedBy = requireActor();

    const ext = payload.fileName.toLowerCase().substring(payload.fileName.lastIndexOf("."));
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new BadRequestException({
        error: {
          code: "UNSUPPORTED_FILE_TYPE",
          message: `File extension ${ext} is not supported.`,
        },
      });
    }

    // Secure org/study scoped storage
    const storageKey = await this.storage.save(payload.fileName, payload.fileBuffer);

    let parsingStatus = "PARSED";
    let extractedText: string | null = null;
    let parseError: string | null = null;
    let chunksList: { chunkIndex: number; chunkText: string; sectionReference: string }[] = [];

    try {
      const result = await this.parseDocumentText(payload.fileName, payload.fileBuffer);
      extractedText = result.text;
      chunksList = this.splitChunks(extractedText);
    } catch (err: unknown) {
      parsingStatus = "FAILED";
      parseError = this.parsingErrorMessage(err);
    }

    const doc = await this.tenant.runInOrgContext(async (tx) => {
      const created = await tx.evidenceDocument.create({
        data: {
          orgId,
          studyId: payload.studyId,
          uploadedBy,
          title: payload.title,
          fileName: payload.fileName,
          fileType: ext,
          storageKey,
          documentType: payload.documentType,
          sourceReferenceId: payload.sourceReferenceId,
          collectedDate: new Date(payload.collectedDate),
          description: payload.description || null,
          linkedNeedId: payload.linkedNeedId || null,
          linkedDomainId: payload.linkedDomainId || null,
          linkedKpiId: payload.linkedKpiId || null,
          parsingStatus,
          extractedText,
          parsedAt: parsingStatus === "PARSED" ? new Date() : null,
          parseError,
          isIncludedInCombinedReport: true,
        },
      });

      if (chunksList.length > 0) {
        await tx.evidenceDocumentChunk.createMany({
          data: chunksList.map((c) => ({
            documentId: created.id,
            chunkIndex: c.chunkIndex,
            sectionReference: c.sectionReference,
            chunkText: c.chunkText,
          })),
        });
      }

      return created;
    });

    await this.audit.record({
      action: "upload_evidence_document",
      entityType: "evidence_document",
      entityId: doc.id,
      entityLabel: doc.title,
    });

    return doc;
  }

  private parsingErrorMessage(err: unknown): string {
    if (err instanceof BadRequestException) {
      const response = err.getResponse();
      if (typeof response === "object" && response !== null && "error" in response) {
        const error = response.error;
        if (typeof error === "object" && error !== null && "message" in error) {
          if (typeof error.message === "string") return error.message;
        }
      }
    }
    return err instanceof Error ? err.message : UNSUPPORTED_SCANNED_MSG;
  }

  async listDocuments(query: ListEvidenceDocumentsQuery) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.findMany({
        where: {
          orgId,
          studyId: query.studyId,
          ...(query.documentType ? { documentType: query.documentType } : {}),
          ...(query.linkedDomainId ? { linkedDomainId: query.linkedDomainId } : {}),
          ...(query.search
            ? {
                OR: [
                  { title: { contains: query.search, mode: "insensitive" } },
                  { fileName: { contains: query.search, mode: "insensitive" } },
                  { sourceReferenceId: { contains: query.search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        include: {
          chunks: true,
          // All summaries, newest first — the document-based summary tab lists
          // every generated summary, not just the latest one. Callers that only
          // care about the current state still read summaries[0].
          summaries: { orderBy: { createdAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  async getDocumentDetails(id: string) {
    const orgId = requireOrgId();
    const doc = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.findFirst({
        where: { id, orgId },
        include: {
          chunks: { orderBy: { chunkIndex: "asc" } },
          summaries: { orderBy: { createdAt: "desc" } },
        },
      }),
    );
    if (!doc) throw new NotFoundException(`Evidence document with id ${id} not found.`);
    return doc;
  }

  // Returns the original uploaded bytes plus the metadata the controller needs
  // to set Content-Type/Disposition. Tenant-scoped like every other read here,
  // so a document from another org is a 404 rather than a download.
  async getDocumentFile(
    id: string,
  ): Promise<{ buffer: Buffer; fileName: string; fileType: string }> {
    const orgId = requireOrgId();
    const doc = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.findFirst({
        where: { id, orgId },
        select: { storageKey: true, fileName: true, fileType: true, title: true },
      }),
    );
    if (!doc) throw new NotFoundException(`Evidence document with id ${id} not found.`);

    const buffer = await this.storage.read(doc.storageKey);

    // Downloading the source file is a disclosure of collected evidence, so it
    // is auditable in the same way exports are.
    await this.audit.record({
      action: "download_evidence_document",
      entityType: "evidence_document",
      entityId: id,
      entityLabel: doc.title,
    });

    return { buffer, fileName: doc.fileName, fileType: doc.fileType };
  }

  async toggleInclusion(id: string, isIncluded: boolean) {
    const orgId = requireOrgId();
    const doc = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.findFirst({ where: { id, orgId } }),
    );
    if (!doc) throw new NotFoundException(`Evidence document with id ${id} not found.`);

    const updated = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.update({
        where: { id },
        data: { isIncludedInCombinedReport: isIncluded },
      }),
    );

    // Invalidate any combined summary for this study to STALE
    await this.tenant.runInOrgContext((tx) =>
      tx.combinedReportSummary.updateMany({
        where: { studyId: doc.studyId, status: "OFFICER_CONFIRMED" },
        data: { status: "STALE" },
      }),
    );

    return updated;
  }

  async deleteDocument(id: string) {
    const orgId = requireOrgId();
    const doc = await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.findFirst({
        where: { id, orgId },
        include: {
          combinedSources: {
            include: {
              combinedSummary: true,
            },
          },
        },
      }),
    );
    if (!doc) throw new NotFoundException(`Evidence document with id ${id} not found.`);

    const usedInConfirmedReport = doc.combinedSources.some(
      (s) => s.combinedSummary.status === "OFFICER_CONFIRMED",
    );
    if (usedInConfirmedReport) {
      throw new ForbiddenException(
        "Cannot delete document because it is included in an officer-confirmed combined report.",
      );
    }

    await this.tenant.runInOrgContext((tx) =>
      tx.evidenceDocument.delete({ where: { id } }),
    );

    await this.audit.record({
      action: "delete_evidence_document",
      entityType: "evidence_document",
      entityId: id,
      entityLabel: doc.title,
    });

    return { success: true };
  }

}

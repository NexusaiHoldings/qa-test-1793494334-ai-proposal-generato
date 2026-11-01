"use server";

/**
 * Case-Study Library — server actions (F1-003).
 *
 * The ingestion pipeline: the consultant drops in a PDF/DOCX (or pastes text);
 * the file is stored + registered through @nexus/files-and-media; the gateway
 * extracts a structured case study; PII is flagged before indexing; and the
 * anonymised narrative is chunked + embedded into the pgvector RAG corpus.
 *
 * Inline edits autosave a single field at a time. Toggling a case study
 * public/anonymised rebuilds the narrative and re-indexes it so no confidential
 * client name leaks into (or lingers in) the corpus.
 *
 * Every action calls requireProposalAccess() first, so all writes are scoped to
 * a single organizationId.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { handleRegisterFile } from "@nexus/files-and-media";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import { storeBlob } from "@/lib/file-storage";
import { requireProposalAccess } from "@/lib/proposals/access";
import {
  extractDocumentText,
  extractCaseStudy,
  flagPiiAnomalies,
  buildNarrative,
  UnreadableDocumentError,
} from "@/lib/proposals/case-study-extract";
import { indexCaseStudyNarrative } from "@/lib/proposals/embeddings";
import {
  insertCaseStudy,
  getCaseStudy,
  updateCaseStudyField,
  updateCaseStudyServices,
  updateCaseStudyNarrative,
  setCaseStudyPublic,
  deleteCaseStudy,
} from "@/lib/proposals/library-queries";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function asNullable(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function asBool(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}

/**
 * Store + register an uploaded document and return its text.
 *
 * Returns the registered fileId (null when the consultant pasted text). Throws
 * UnreadableDocumentError when the bytes can't be turned into text.
 */
async function ingestUploadedFile(
  userId: string,
  file: File,
): Promise<{ fileId: string | null; text: string }> {
  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new UnreadableDocumentError("File too large (max 10MB).");
  }
  const bytes = Buffer.from(arrayBuffer);
  const contentType = file.type || "application/octet-stream";

  // Extract text first so an unreadable file never leaves an orphan blob.
  const text = await extractDocumentText({
    bytes,
    mimeType: contentType,
    filename: file.name || "upload",
  });

  let fileId: string | null = null;
  try {
    const storageKey = await storeBlob(bytes, contentType);
    const result = await handleRegisterFile(
      { db: buildDb(), events: buildEventBus() },
      {
        user_id: userId,
        filename: file.name || "upload",
        mime_type: contentType,
        size_bytes: bytes.length,
        storage_key: storageKey,
      },
    );
    if (result.status >= 200 && result.status < 300 && result.body && typeof result.body === "object") {
      const body = result.body as { file_id?: string };
      fileId = body.file_id ?? null;
    }
  } catch (error) {
    // Registration is best-effort — the extraction already succeeded, so we
    // still ingest the case study even if blob storage/metadata hiccups.
    console.warn(
      JSON.stringify({
        level: "warn",
        at: "library.ingestUploadedFile",
        msg: "file registration failed; continuing with extracted text",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return { fileId, text };
}

/**
 * Ingest a case study from an uploaded file or pasted text. On success the
 * consultant is redirected to the new case study's detail page; on an unreadable
 * file with no pasted fallback they are sent back with an error flag so the UI
 * can offer "paste the text instead".
 */
export async function ingestCaseStudyAction(formData: FormData): Promise<void> {
  const { userId, organizationId } = await requireProposalAccess();

  const pasted = asNullable(formData.get("pastedText"));
  const clientNameOverride = asNullable(formData.get("clientName"));
  const clientIsPublic = asBool(formData.get("clientIsPublic"));
  const fileEntry = formData.get("file");
  const hasFile = fileEntry instanceof File && fileEntry.size > 0;

  let sourceFileId: string | null = null;
  let sourceKind = "paste";
  let documentText: string | null = null;

  try {
    if (hasFile) {
      const uploaded = await ingestUploadedFile(userId, fileEntry);
      sourceFileId = uploaded.fileId;
      documentText = uploaded.text;
      sourceKind = "upload";
    } else if (pasted) {
      documentText = pasted;
      sourceKind = "paste";
    } else {
      redirect("/library?error=empty");
    }
  } catch (error) {
    if (error instanceof UnreadableDocumentError) {
      if (pasted) {
        documentText = pasted;
        sourceKind = "paste";
      } else {
        redirect("/library?error=unreadable");
      }
    } else {
      throw error;
    }
  }

  if (!documentText) {
    redirect("/library?error=empty");
  }

  const extracted = await extractCaseStudy(documentText);
  const piiFindings = flagPiiAnomalies(documentText);

  const clientName = clientNameOverride ?? extracted.clientName;
  const narrative = buildNarrative(
    { ...extracted, clientName },
    clientIsPublic,
  );

  const caseStudyId = await insertCaseStudy({
    organizationId,
    createdByUserId: userId,
    sourceFileId,
    sourceKind,
    title: extracted.title,
    clientName,
    clientIsPublic,
    industry: extracted.industry,
    problem: extracted.problem,
    approach: extracted.approach,
    outcomes: extracted.outcomes,
    headlineMetric: extracted.headlineMetric,
    metrics: extracted.metrics,
    services: extracted.services,
    duration: extracted.duration,
    narrative,
    extractionConfidence: extracted.confidence,
    extractionModel: extracted.model,
    piiFlagged: piiFindings.length > 0,
    piiFindings,
    status: "ready",
  });

  // Chunk + embed the narrative into the pgvector RAG corpus.
  try {
    await indexCaseStudyNarrative(buildDb(), {
      caseStudyId,
      organizationId,
      narrative,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        at: "library.ingestCaseStudyAction",
        msg: "indexing failed after insert",
        caseStudyId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  revalidatePath("/library");
  redirect(`/library/${caseStudyId}`);
}

/** Autosave a single inline-edited text field on a case study. */
export async function updateCaseStudyFieldAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  const field = asNullable(formData.get("field"));
  if (!id || !field) throw new Error("id and field are required");

  const value = asNullable(formData.get("value"));
  const result = await updateCaseStudyField(organizationId, id, field, value);
  if (!result.ok) throw new Error(`Field not editable: ${field}`);

  revalidatePath(`/library/${id}`);
  revalidatePath("/library");
}

/** Save the comma-separated services list for a case study. */
export async function updateServicesAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  const raw = asNullable(formData.get("services"));
  const services = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  await updateCaseStudyServices(organizationId, id, services);

  revalidatePath(`/library/${id}`);
}

/**
 * Toggle whether the client identity is public. Because anonymisation changes
 * what enters the RAG corpus, the narrative is rebuilt and the case study is
 * re-indexed.
 */
export async function togglePublicAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  const makePublic = asBool(formData.get("clientIsPublic"));
  await setCaseStudyPublic(organizationId, id, makePublic);

  const study = await getCaseStudy(organizationId, id);
  if (study) {
    const narrative = buildNarrative(study, makePublic);
    await updateCaseStudyNarrative(organizationId, id, narrative);
    try {
      await indexCaseStudyNarrative(buildDb(), { caseStudyId: id, organizationId, narrative });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          at: "library.togglePublicAction",
          msg: "re-index failed after visibility change",
          caseStudyId: id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  revalidatePath(`/library/${id}`);
  revalidatePath("/library");
}

/** Re-chunk + re-embed a case study's narrative (after inline edits). */
export async function reindexCaseStudyAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  const study = await getCaseStudy(organizationId, id);
  if (!study) redirect("/library?error=notfound");

  const narrative = buildNarrative(study!, study!.clientIsPublic);
  await updateCaseStudyNarrative(organizationId, id, narrative);
  await indexCaseStudyNarrative(buildDb(), { caseStudyId: id, organizationId, narrative });

  revalidatePath(`/library/${id}`);
}

/** Permanently delete a case study and its chunks. */
export async function deleteCaseStudyAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  await deleteCaseStudy(organizationId, id);

  revalidatePath("/library");
  redirect("/library");
}

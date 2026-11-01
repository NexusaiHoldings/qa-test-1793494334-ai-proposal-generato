"use server";

/**
 * RFP Intake — server actions (F1-004).
 *
 * The intake pipeline: the consultant drops a PDF/DOCX (or pastes text) when a
 * new RFP lands; rfp-text.ts extracts the text layer (routing scanned PDFs to the
 * gateway for vision transcription); rfp-parser.ts produces the requirements,
 * weighted evaluation criteria, deadline, submission format and page limit with
 * per-field confidence and parse_warnings; section-mapper.ts maps each
 * requirement to a proposal section; and the whole intake is persisted. The
 * uploaded file is stored + registered through @nexus/files-and-media.
 *
 * Inline edits autosave a single field (or weight) at a time. Every action calls
 * requireProposalAccess() first so all writes are scoped to one organizationId.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { handleRegisterFile } from "@nexus/files-and-media";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import { storeBlob } from "@/lib/file-storage";
import { requireProposalAccess } from "@/lib/proposals/access";
import { extractRfpText, UnreadableRfpError } from "@/lib/proposals/rfp-text";
import {
  parseRfp,
  createRfpWithDetails,
  getRfp,
  updateRfpField,
  updateRfpPageLimit,
  updateRfpDeadline,
  updateRequirementTextField,
  updateRequirementWeight,
  deleteRequirement,
  deleteRfp,
  updateRfpParse,
} from "@/lib/proposals/rfp-parser";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function asNullable(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function asBool(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}

function asPositiveInt(value: FormDataEntryValue | null): number | null {
  const text = asNullable(value);
  if (!text) return null;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function asWeight(value: FormDataEntryValue | null): number {
  const text = asNullable(value);
  if (!text) return 0;
  let n = Number(text);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) n = n / 100; // accept a 0..100 percentage input
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 100) / 100;
}

/**
 * Store + register an uploaded document and return its extracted text. The file
 * id is null when registration fails (best-effort) — extraction already
 * succeeded so we still ingest the RFP.
 */
async function ingestUploadedFile(
  userId: string,
  file: File,
): Promise<{ fileId: string | null; text: string; isScanned: boolean; warnings: string[] }> {
  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new UnreadableRfpError("File too large (max 15MB).");
  }
  const bytes = Buffer.from(arrayBuffer);
  const contentType = file.type || "application/octet-stream";

  // Extract text first so an unreadable file never leaves an orphan blob.
  const extracted = await extractRfpText({
    bytes,
    mimeType: contentType,
    filename: file.name || "rfp-upload",
  });

  let fileId: string | null = null;
  try {
    const storageKey = await storeBlob(bytes, contentType);
    const result = await handleRegisterFile(
      { db: buildDb(), events: buildEventBus() },
      {
        user_id: userId,
        filename: file.name || "rfp-upload",
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
    console.warn(
      JSON.stringify({
        level: "warn",
        at: "rfps.ingestUploadedFile",
        msg: "file registration failed; continuing with extracted text",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return { fileId, text: extracted.text, isScanned: extracted.isScanned, warnings: extracted.warnings };
}

/**
 * Create an RFP from an uploaded file or pasted text. On success the consultant
 * is redirected to the new RFP's split view; on an unreadable file with no pasted
 * fallback they are sent back with an error flag.
 */
export async function createRfpAction(formData: FormData): Promise<void> {
  const { userId, organizationId } = await requireProposalAccess();

  const pasted = asNullable(formData.get("pastedText"));
  const fileEntry = formData.get("file");
  const hasFile = fileEntry instanceof File && fileEntry.size > 0;

  let sourceFileId: string | null = null;
  let sourceKind = "paste";
  let documentText: string | null = null;
  let isScanned = false;
  const extraWarnings: string[] = [];

  try {
    if (hasFile) {
      const uploaded = await ingestUploadedFile(userId, fileEntry);
      sourceFileId = uploaded.fileId;
      documentText = uploaded.text;
      isScanned = uploaded.isScanned;
      extraWarnings.push(...uploaded.warnings);
      sourceKind = "upload";
    } else if (pasted) {
      documentText = pasted;
      sourceKind = "paste";
    } else {
      redirect("/rfps/new?error=empty");
    }
  } catch (error) {
    if (error instanceof UnreadableRfpError) {
      if (pasted) {
        documentText = pasted;
        sourceKind = "paste";
      } else {
        redirect("/rfps/new?error=unreadable");
      }
    } else {
      throw error;
    }
  }

  if (!documentText) {
    redirect("/rfps/new?error=empty");
  }

  const parsed = await parseRfp(documentText);

  const rfpId = await createRfpWithDetails({
    organizationId,
    createdByUserId: userId,
    sourceFileId,
    sourceKind,
    rawText: documentText,
    isScanned,
    parsed,
    extraWarnings,
  });

  revalidatePath("/rfps");
  redirect(`/rfps/${rfpId}`);
}

/** Autosave a single inline-edited text field on the RFP header. */
export async function updateRfpFieldAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  const field = asNullable(formData.get("field"));
  if (!id || !field) throw new Error("id and field are required");

  const value = asNullable(formData.get("value"));
  const ok = await updateRfpField(organizationId, id, field, value);
  if (!ok) throw new Error(`Field not editable: ${field}`);

  revalidatePath(`/rfps/${id}`);
  revalidatePath("/rfps");
}

/** Save the page limit on an RFP. */
export async function updateRfpPageLimitAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  await updateRfpPageLimit(organizationId, id, asPositiveInt(formData.get("pageLimit")));
  revalidatePath(`/rfps/${id}`);
}

/** Save the submission deadline (date + optional free-text) on an RFP. */
export async function updateRfpDeadlineAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  const rawDate = asNullable(formData.get("deadlineAt"));
  let deadlineAt: string | null = null;
  if (rawDate) {
    const parsed = Date.parse(rawDate);
    if (!Number.isNaN(parsed)) deadlineAt = new Date(parsed).toISOString();
  }
  const deadlineText = asNullable(formData.get("deadlineText")) ?? rawDate;

  await updateRfpDeadline(organizationId, id, deadlineAt, deadlineText);
  revalidatePath(`/rfps/${id}`);
}

/** Autosave a single inline-edited text field on a requirement card. */
export async function updateRequirementFieldAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const rfpId = asNullable(formData.get("rfpId"));
  const requirementId = asNullable(formData.get("requirementId"));
  const field = asNullable(formData.get("field"));
  if (!requirementId || !field) throw new Error("requirementId and field are required");

  const value = asNullable(formData.get("value"));
  const ok = await updateRequirementTextField(organizationId, requirementId, field, value);
  if (!ok) throw new Error(`Field not editable: ${field}`);

  if (rfpId) revalidatePath(`/rfps/${rfpId}`);
}

/** Save the weight + mandatory flag on a requirement (weight-bar edit). */
export async function updateRequirementWeightAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const rfpId = asNullable(formData.get("rfpId"));
  const requirementId = asNullable(formData.get("requirementId"));
  if (!requirementId) throw new Error("requirementId is required");

  await updateRequirementWeight(
    organizationId,
    requirementId,
    asWeight(formData.get("weight")),
    asBool(formData.get("mandatory")),
  );
  if (rfpId) revalidatePath(`/rfps/${rfpId}`);
}

/** Delete a single requirement from an RFP. */
export async function deleteRequirementAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const rfpId = asNullable(formData.get("rfpId"));
  const requirementId = asNullable(formData.get("requirementId"));
  if (!requirementId) throw new Error("requirementId is required");

  await deleteRequirement(organizationId, requirementId);
  if (rfpId) revalidatePath(`/rfps/${rfpId}`);
}

/** Re-run parsing over the stored raw text (e.g. after the gateway recovers). */
export async function reparseRfpAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  const rfp = await getRfp(organizationId, id);
  if (!rfp) redirect("/rfps?error=notfound");

  const parsed = await parseRfp(rfp!.rawText);
  await updateRfpParse(organizationId, id, rfp!.rawText, parsed, rfp!.isScanned);

  revalidatePath(`/rfps/${id}`);
  revalidatePath("/rfps");
}

/** Permanently delete an RFP and its requirements + criteria. */
export async function deleteRfpAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("id is required");

  await deleteRfp(organizationId, id);
  revalidatePath("/rfps");
  redirect("/rfps");
}

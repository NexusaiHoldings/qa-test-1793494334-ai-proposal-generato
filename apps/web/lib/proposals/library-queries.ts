/**
 * Case-Study Library — server-side data access (F1-003).
 *
 * Reads/writes the extracted case studies (proposals_case_studies) and their
 * pgvector chunks (proposals_case_study_chunks) that make up the RAG corpus.
 *
 * All queries are parameterized ($1, $2, ...) and scoped to organizationId for
 * per-consultant isolation. Raw SQL runs through the substrate pool (@/lib/db
 * buildDb); no ORM. All IDs are UUID.
 */
import { buildDb } from "@/lib/db";
import type { QuantifiedMetric, PiiFinding } from "@/lib/proposals/case-study-extract";

export type CaseStudyStatus = "extracting" | "ready" | "error";

export type CaseStudy = {
  id: string;
  organizationId: string;
  sourceFileId: string | null;
  sourceKind: string;
  title: string | null;
  clientName: string | null;
  clientIsPublic: boolean;
  industry: string | null;
  problem: string | null;
  approach: string | null;
  outcomes: string | null;
  headlineMetric: string | null;
  metrics: QuantifiedMetric[];
  services: string[];
  duration: string | null;
  narrative: string | null;
  extractionConfidence: number;
  extractionModel: string | null;
  piiFlagged: boolean;
  piiFindings: PiiFinding[];
  status: string;
  indexedAt: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CaseStudyChunkRow = {
  id: string;
  chunkIndex: number;
  content: string;
  tokenEstimate: number;
  embeddingModel: string | null;
};

interface RawCaseStudyRow {
  id: string;
  organizationId: string;
  sourceFileId: string | null;
  sourceKind: string;
  title: string | null;
  clientName: string | null;
  clientIsPublic: boolean;
  industry: string | null;
  problem: string | null;
  approach: string | null;
  outcomes: string | null;
  headlineMetric: string | null;
  metrics: unknown;
  services: unknown;
  duration: string | null;
  narrative: string | null;
  extractionConfidence: number | string;
  extractionModel: string | null;
  piiFlagged: boolean;
  piiFindings: unknown;
  status: string;
  indexedAt: string | null;
  chunkCount: number | string;
  createdAt: string;
  updatedAt: string;
}

function coerceMetrics(value: unknown): QuantifiedMetric[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  const metrics: QuantifiedMetric[] = [];
  for (const raw of parsed) {
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label : null;
      const metricValue = typeof record.value === "string" ? record.value : null;
      if (label && metricValue) metrics.push({ label, value: metricValue });
    }
  }
  return metrics;
}

function coerceFindings(value: unknown): PiiFinding[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  const findings: PiiFinding[] = [];
  for (const raw of parsed) {
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const kind = record.kind;
      if (kind === "email" || kind === "phone" || kind === "gov_id" || kind === "ssn") {
        findings.push({
          kind,
          sample: typeof record.sample === "string" ? record.sample : "",
          count: typeof record.count === "number" ? record.count : Number(record.count) || 0,
        });
      }
    }
  }
  return findings;
}

function coerceServices(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    const parsed = safeJson(value);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  }
  return [];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapRow(row: RawCaseStudyRow): CaseStudy {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sourceFileId: row.sourceFileId,
    sourceKind: row.sourceKind,
    title: row.title,
    clientName: row.clientName,
    clientIsPublic: Boolean(row.clientIsPublic),
    industry: row.industry,
    problem: row.problem,
    approach: row.approach,
    outcomes: row.outcomes,
    headlineMetric: row.headlineMetric,
    metrics: coerceMetrics(row.metrics),
    services: coerceServices(row.services),
    duration: row.duration,
    narrative: row.narrative,
    extractionConfidence: Number(row.extractionConfidence) || 0,
    extractionModel: row.extractionModel,
    piiFlagged: Boolean(row.piiFlagged),
    piiFindings: coerceFindings(row.piiFindings),
    status: row.status,
    indexedAt: row.indexedAt,
    chunkCount: Number(row.chunkCount) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SELECT_COLUMNS = `
  cs.id,
  cs.organization_id AS "organizationId",
  cs.source_file_id AS "sourceFileId",
  cs.source_kind AS "sourceKind",
  cs.title,
  cs.client_name AS "clientName",
  cs.client_is_public AS "clientIsPublic",
  cs.industry,
  cs.problem,
  cs.approach,
  cs.outcomes,
  cs.headline_metric AS "headlineMetric",
  cs.metrics,
  cs.services,
  cs.duration,
  cs.narrative,
  cs.extraction_confidence AS "extractionConfidence",
  cs.extraction_model AS "extractionModel",
  cs.pii_flagged AS "piiFlagged",
  cs.pii_findings AS "piiFindings",
  cs.status,
  cs.indexed_at AS "indexedAt",
  cs.created_at AS "createdAt",
  cs.updated_at AS "updatedAt",
  (SELECT COUNT(*) FROM proposals_case_study_chunks c
     WHERE c.case_study_id = cs.id) AS "chunkCount"
`;

export async function listCaseStudies(organizationId: string): Promise<CaseStudy[]> {
  const db = buildDb();
  const rows = await db.query<RawCaseStudyRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM proposals_case_studies cs
      WHERE cs.organization_id = $1
      ORDER BY cs.created_at DESC`,
    organizationId,
  );
  return rows.map(mapRow);
}

export async function getCaseStudy(organizationId: string, id: string): Promise<CaseStudy | null> {
  const db = buildDb();
  const rows = await db.query<RawCaseStudyRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM proposals_case_studies cs
      WHERE cs.organization_id = $1 AND cs.id = $2
      LIMIT 1`,
    organizationId,
    id,
  );
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function getCaseStudyChunks(
  organizationId: string,
  caseStudyId: string,
): Promise<CaseStudyChunkRow[]> {
  const db = buildDb();
  const rows = await db.query<CaseStudyChunkRow>(
    `SELECT
        id,
        chunk_index AS "chunkIndex",
        content,
        token_estimate AS "tokenEstimate",
        embedding_model AS "embeddingModel"
       FROM proposals_case_study_chunks
      WHERE organization_id = $1 AND case_study_id = $2
      ORDER BY chunk_index ASC`,
    organizationId,
    caseStudyId,
  );
  return rows.map((row) => ({
    ...row,
    chunkIndex: Number(row.chunkIndex),
    tokenEstimate: Number(row.tokenEstimate),
  }));
}

export type InsertCaseStudyInput = {
  organizationId: string;
  createdByUserId: string;
  sourceFileId: string | null;
  sourceKind: string;
  title: string | null;
  clientName: string | null;
  clientIsPublic: boolean;
  industry: string | null;
  problem: string | null;
  approach: string | null;
  outcomes: string | null;
  headlineMetric: string | null;
  metrics: QuantifiedMetric[];
  services: string[];
  duration: string | null;
  narrative: string | null;
  extractionConfidence: number;
  extractionModel: string | null;
  piiFlagged: boolean;
  piiFindings: PiiFinding[];
  status: CaseStudyStatus;
};

export async function insertCaseStudy(input: InsertCaseStudyInput): Promise<string> {
  const db = buildDb();
  const rows = await db.query<{ id: string }>(
    `INSERT INTO proposals_case_studies
       (organization_id, source_file_id, source_kind, title, client_name,
        client_is_public, industry, problem, approach, outcomes,
        headline_metric, metrics, services, duration, narrative,
        extraction_confidence, extraction_model, pii_flagged, pii_findings,
        status, created_by_user_id)
     VALUES
       ($1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12::jsonb, $13::text[], $14, $15,
        $16, $17, $18, $19::jsonb,
        $20, $21)
     RETURNING id`,
    input.organizationId,
    input.sourceFileId,
    input.sourceKind,
    input.title,
    input.clientName,
    input.clientIsPublic,
    input.industry,
    input.problem,
    input.approach,
    input.outcomes,
    input.headlineMetric,
    JSON.stringify(input.metrics),
    input.services,
    input.duration,
    input.narrative,
    input.extractionConfidence,
    input.extractionModel,
    input.piiFlagged,
    JSON.stringify(input.piiFindings),
    input.status,
    input.createdByUserId,
  );
  return rows[0].id;
}

/** Editable free-form text fields a consultant can correct inline (autosave). */
const EDITABLE_TEXT_FIELDS: Record<string, string> = {
  title: "title",
  clientName: "client_name",
  industry: "industry",
  problem: "problem",
  approach: "approach",
  outcomes: "outcomes",
  headlineMetric: "headline_metric",
  duration: "duration",
};

export type UpdateFieldResult = { ok: boolean; field: string };

/**
 * Update a single editable field on a case study (inline-edit autosave). The
 * field name is whitelisted to a fixed column map, so no caller input ever
 * reaches the SQL identifier position — only the value is parameterized.
 */
export async function updateCaseStudyField(
  organizationId: string,
  id: string,
  field: string,
  value: string | null,
): Promise<UpdateFieldResult> {
  const column = EDITABLE_TEXT_FIELDS[field];
  if (!column) return { ok: false, field };

  const db = buildDb();
  await db.execute(
    `UPDATE proposals_case_studies
        SET ${column} = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    value,
    id,
    organizationId,
  );
  return { ok: true, field };
}

export async function updateCaseStudyServices(
  organizationId: string,
  id: string,
  services: string[],
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_case_studies
        SET services = $1::text[], updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    services,
    id,
    organizationId,
  );
}

export async function setCaseStudyPublic(
  organizationId: string,
  id: string,
  isPublic: boolean,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_case_studies
        SET client_is_public = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    isPublic,
    id,
    organizationId,
  );
}

export async function setCaseStudyStatus(
  organizationId: string,
  id: string,
  status: CaseStudyStatus,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_case_studies
        SET status = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    status,
    id,
    organizationId,
  );
}

export async function updateCaseStudyNarrative(
  organizationId: string,
  id: string,
  narrative: string,
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE proposals_case_studies
        SET narrative = $1, updated_at = now()
      WHERE id = $2 AND organization_id = $3`,
    narrative,
    id,
    organizationId,
  );
}

export async function deleteCaseStudy(organizationId: string, id: string): Promise<void> {
  const db = buildDb();
  // Chunks first (no FK cascade declared across domain tables), then the study.
  await db.execute(
    `DELETE FROM proposals_case_study_chunks
      WHERE organization_id = $1 AND case_study_id = $2`,
    organizationId,
    id,
  );
  await db.execute(
    `DELETE FROM proposals_case_studies
      WHERE organization_id = $1 AND id = $2`,
    organizationId,
    id,
  );
}

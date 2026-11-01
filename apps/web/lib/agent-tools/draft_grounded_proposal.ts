import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type CitationInput = {
  sourceType: string;
  sourceId?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  quote?: string | null;
  confidence?: number | null;
};

type SectionInput = {
  sectionKey: string;
  heading: string;
  content: string;
  orderIndex: number;
  factualSentences: Array<{
    sentence: string;
    citations: CitationInput[];
  }>;
};

type Args = {
  proposalId: string;
  organizationId?: string;
  templateId?: string | null;
  model?: string | null;
  sections: SectionInput[];
  runMetadata?: Record<string, JsonValue>;
};

type DbLike = {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

type SessionLike = {
  user?: {
    id?: string;
    organizationId?: string;
  };
};

const EIGHT_SECTIONS = 8;

function asDb(ctx: HandlerContext): DbLike {
  const maybeDb = (ctx as unknown as { db?: DbLike }).db;
  if (!maybeDb || typeof maybeDb.query !== "function") {
    throw new Error("Database client missing from handler context.");
  }
  return maybeDb;
}

function asSession(ctx: HandlerContext): SessionLike | null {
  const session = (ctx as unknown as { session?: SessionLike }).session;
  return session ?? null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeArgs(raw: Record<string, unknown>): Args {
  const proposalId = String(raw.proposalId ?? "");
  const organizationId = raw.organizationId ? String(raw.organizationId) : undefined;
  const templateId = raw.templateId ? String(raw.templateId) : null;
  const model = raw.model ? String(raw.model) : null;
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : [];
  const runMetadata =
    raw.runMetadata && typeof raw.runMetadata === "object"
      ? (raw.runMetadata as Record<string, JsonValue>)
      : {};

  const sections: SectionInput[] = sectionsRaw.map((s, idx) => {
    const sec = (s ?? {}) as Record<string, unknown>;
    const factualSentencesRaw = Array.isArray(sec.factualSentences) ? sec.factualSentences : [];
    return {
      sectionKey: String(sec.sectionKey ?? `section_${idx + 1}`),
      heading: String(sec.heading ?? `Section ${idx + 1}`),
      content: String(sec.content ?? ""),
      orderIndex: Number.isFinite(Number(sec.orderIndex)) ? Number(sec.orderIndex) : idx,
      factualSentences: factualSentencesRaw.map((f) => {
        const fr = (f ?? {}) as Record<string, unknown>;
        const citationsRaw = Array.isArray(fr.citations) ? fr.citations : [];
        return {
          sentence: String(fr.sentence ?? ""),
          citations: citationsRaw.map((c) => {
            const cr = (c ?? {}) as Record<string, unknown>;
            return {
              sourceType: String(cr.sourceType ?? "unknown"),
              sourceId: cr.sourceId ? String(cr.sourceId) : null,
              sourceTitle: cr.sourceTitle ? String(cr.sourceTitle) : null,
              sourceUrl: cr.sourceUrl ? String(cr.sourceUrl) : null,
              quote: cr.quote ? String(cr.quote) : null,
              confidence: cr.confidence == null ? null : Number(cr.confidence),
            };
          }),
        };
      }),
    };
  });

  return { proposalId, organizationId, templateId, model, sections, runMetadata };
}

export async function handleDraftGroundedProposal(
  ctx: HandlerContext,
  args: Record<string, unknown>,
): Promise<HandlerResult> {
  try {
    const parsed = normalizeArgs(args);
    const session = asSession(ctx);
    const db = asDb(ctx);

    if (!isUuid(parsed.proposalId)) {
      return { ok: false, error: { code: "invalid_args", message: "proposalId must be a UUID." } };
    }

    const organizationId = parsed.organizationId ?? session?.user?.organizationId;
    if (!organizationId || !isUuid(organizationId)) {
      return {
        ok: false,
        error: { code: "invalid_args", message: "organizationId is required and must be UUID." },
      };
    }

    if (parsed.sections.length !== EIGHT_SECTIONS) {
      return {
        ok: false,
        error: {
          code: "invalid_args",
          message: `Exactly ${EIGHT_SECTIONS} sections are required.`,
        },
      };
    }

    const actorUserId = session?.user?.id && isUuid(session.user.id) ? session.user.id : null;
    const runIdRow = await db.query<{ id: string }>("SELECT gen_random_uuid() AS id");
    const runId = runIdRow.rows[0]?.id;
    if (!runId) {
      return { ok: false, error: { code: "internal_error", message: "Failed to allocate run id." } };
    }

    await db.query("BEGIN");

    await db.query(
      "INSERT INTO proposals_generation_runs (id, organization_id, proposal_id, template_id, model, status, metadata, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
      [
        runId,
        organizationId,
        parsed.proposalId,
        parsed.templateId,
        parsed.model ?? "unknown",
        "running",
        JSON.stringify(parsed.runMetadata ?? {}),
        actorUserId,
      ],
    );

    await db.query(
      "DELETE FROM proposals_citations WHERE organization_id = $1 AND proposal_id = $2",
      [organizationId, parsed.proposalId],
    );
    await db.query(
      "DELETE FROM proposals_sections WHERE organization_id = $1 AND proposal_id = $2",
      [organizationId, parsed.proposalId],
    );

    for (const section of parsed.sections.sort((a, b) => a.orderIndex - b.orderIndex)) {
      await db.query(
        "INSERT INTO proposals_sections (id, organization_id, proposal_id, section_key, heading, content, order_index, generation_run_id) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)",
        [
          organizationId,
          parsed.proposalId,
          section.sectionKey,
          section.heading,
          section.content,
          section.orderIndex,
          runId,
        ],
      );

      for (const fs of section.factualSentences) {
        const sentence = fs.sentence.trim();
        if (!sentence) continue;

        for (const citation of fs.citations) {
          await db.query(
            "INSERT INTO proposals_citations (id, organization_id, proposal_id, section_key, sentence_text, source_type, source_id, source_title, source_url, quote, confidence, generation_run_id) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              organizationId,
              parsed.proposalId,
              section.sectionKey,
              sentence,
              citation.sourceType,
              citation.sourceId,
              citation.sourceTitle,
              citation.sourceUrl,
              citation.quote,
              citation.confidence,
              runId,
            ],
          );
        }
      }
    }

    await db.query(
      "UPDATE proposals_generation_runs SET status = $1, completed_at = NOW() WHERE id = $2 AND organization_id = $3",
      ["completed", runId, organizationId],
    );

    await db.query("COMMIT");

    return {
      ok: true,
      data: {
        proposalId: parsed.proposalId,
        generationRunId: runId,
        sectionsWritten: parsed.sections.length,
      },
    };
  } catch (error) {
    const db = (ctx as unknown as { db?: DbLike }).db;
    if (db) {
      try {
        await db.query("ROLLBACK");
      } catch {
        // no-op rollback best effort
      }
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, error: { code: "draft_grounded_proposal_failed", message } };
  }
}

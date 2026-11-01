/**
 * Company-local agent tool: `draft_grounded_proposal`.
 *
 * Confirm-gated mutation (autonomy = confirm). The consultant presses
 * "Generate" after selecting a vertical template; the approved-actions bridge
 * routes the mutation here. This handler persists the eight proposal sections
 * into `proposals_sections`, emits a `proposals_citations` row per factual
 * sentence (so every claim is grounded + traceable), and records the whole
 * attempt in `proposals_generation_runs`.
 *
 * Follows the lego handler contract exactly (see
 * legos/identity-and-access/api/_lib/handler.ts + db.ts):
 *   - signature `(ctx: HandlerContext, args) => Promise<HandlerResult>`
 *   - `ctx.db.query<T>(sql, ...params)` returns `T[]` (asyncpg-style $1/$2)
 *   - `ctx.db.execute(sql, ...params)` for writes that need no row back
 *   - `HandlerResult` is `{ status, body, headers? }`
 *   - parameterized queries only ($1, $2, …) — never string interpolation
 *   - all IDs are UUID (generated via crypto.randomUUID())
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** The eight fixed proposal sections, in render order. */
const SECTION_KEYS: readonly string[] = [
  "executive_summary",
  "understanding_your_needs",
  "scope_and_deliverables",
  "approach_and_methodology",
  "timeline_and_milestones",
  "team_and_experience",
  "pricing_and_terms",
  "next_steps",
] as const;

interface SentenceCitationInput {
  readonly sentence: string;
  readonly sourceId: string | null;
  readonly sourceType: string | null;
  readonly sourceUrl: string | null;
  readonly excerpt: string | null;
}

interface SectionInput {
  readonly key: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly citations: SentenceCitationInput[];
}

interface ParsedArgs {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly generatedByUserId: string;
  readonly model: string | null;
  readonly verticalTemplateId: string | null;
  readonly sections: SectionInput[];
}

interface IdRow {
  readonly id: string;
}

/** Build a non-2xx plain-text result (mirrors the lego `err` helper). */
function err(status: number, message: string): HandlerResult {
  return { status, body: message };
}

/** Build a 2xx JSON result (mirrors the lego `ok` helper). */
function ok(body: Record<string, unknown>, status = 200): HandlerResult {
  return { status, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Trim a value to a non-empty string, else null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseCitations(value: unknown): SentenceCitationInput[] {
  if (!Array.isArray(value)) return [];

  const parsed: SentenceCitationInput[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const sentence = asString(raw.sentence);
    if (!sentence) continue;
    parsed.push({
      sentence,
      sourceId: asString(raw.sourceId),
      sourceType: asString(raw.sourceType),
      sourceUrl: asString(raw.sourceUrl),
      excerpt: asString(raw.excerpt),
    });
  }
  return parsed;
}

function parseSections(value: unknown): SectionInput[] {
  if (!Array.isArray(value)) return [];

  const parsed: SectionInput[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const key = asString(raw.key);
    if (!key) continue;
    parsed.push({
      key,
      title: asString(raw.title),
      content: asString(raw.content),
      citations: parseCitations(raw.citations),
    });
  }
  return parsed;
}

function parseArgs(args: Args): ParsedArgs | null {
  const proposalId = asString(args.proposalId);
  const organizationId = asString(args.organizationId);
  const generatedByUserId = asString(args.generatedByUserId);

  if (!proposalId || !organizationId || !generatedByUserId) {
    return null;
  }

  return {
    proposalId,
    organizationId,
    generatedByUserId,
    model: asString(args.model),
    verticalTemplateId: asString(args.verticalTemplateId),
    sections: parseSections(args.sections),
  };
}

/** Title-case a snake_case section key for a human-readable default title. */
function humanizeKey(key: string): string {
  return key
    .split("_")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/**
 * Split section prose into factual sentences. A citation row is written for
 * each sentence so every claim in the proposal is individually grounded.
 */
function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export async function handleDraftGroundedProposal(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed = parseArgs(args);
  if (!parsed) {
    return err(400, "proposalId, organizationId, and generatedByUserId are required");
  }

  const { proposalId, organizationId, generatedByUserId, model, verticalTemplateId } = parsed;

  // Default to the eight empty sections when the caller supplied none — the
  // consultant can fill them in on the artifact surface afterwards.
  const sections: SectionInput[] =
    parsed.sections.length > 0
      ? parsed.sections
      : SECTION_KEYS.map((key) => ({
          key,
          title: humanizeKey(key),
          content: "",
          citations: [],
        }));

  const runId = crypto.randomUUID();

  // 1) Record the generation run up front in a 'running' state so a partial
  //    failure still leaves an audit trail.
  try {
    await ctx.db.execute(
      `INSERT INTO proposals_generation_runs
         (id, proposal_id, organization_id, generated_by_user_id,
          model_name, vertical_template_id, status, started_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, 'running', NOW())`,
      runId,
      proposalId,
      organizationId,
      generatedByUserId,
      model,
      verticalTemplateId,
    );
  } catch {
    return err(500, "failed to create generation run");
  }

  let sectionsWritten = 0;
  let citationsWritten = 0;

  try {
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const sectionId = crypto.randomUUID();
      const content = section.content ?? "";
      const title = section.title ?? humanizeKey(section.key);

      const sectionRows = await ctx.db.query<IdRow>(
        `INSERT INTO proposals_sections
           (id, proposal_id, organization_id, generation_run_id,
            section_key, section_title, section_order, content,
            created_by_user_id, updated_by_user_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 $5, $6, $7, $8, $9::uuid, $9::uuid, NOW(), NOW())
         RETURNING id`,
        sectionId,
        proposalId,
        organizationId,
        runId,
        section.key,
        title,
        i + 1,
        content,
        generatedByUserId,
      );

      if (sectionRows.length === 0) continue;
      sectionsWritten += 1;

      // Index explicit citations by the sentence they support.
      const citationsBySentence = new Map<string, SentenceCitationInput[]>();
      for (const citation of section.citations) {
        const bucket = citationsBySentence.get(citation.sentence) ?? [];
        bucket.push(citation);
        citationsBySentence.set(citation.sentence, bucket);
      }

      const sentences = splitSentences(content);
      for (let s = 0; s < sentences.length; s += 1) {
        const sentence = sentences[s];
        const explicit = citationsBySentence.get(sentence) ?? [];
        // Always write at least one citation row per factual sentence; when no
        // explicit source was provided the row is an ungrounded placeholder the
        // consultant can resolve on the artifact surface.
        const toWrite: SentenceCitationInput[] =
          explicit.length > 0
            ? explicit
            : [{ sentence, sourceId: null, sourceType: null, sourceUrl: null, excerpt: null }];

        for (const citation of toWrite) {
          await ctx.db.execute(
            `INSERT INTO proposals_citations
               (id, proposal_id, organization_id, section_id,
                sentence_order, sentence_text, source_id, source_type,
                source_url, source_excerpt, created_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                     $5, $6, $7, $8, $9, $10, NOW())`,
            crypto.randomUUID(),
            proposalId,
            organizationId,
            sectionId,
            s + 1,
            sentence,
            citation.sourceId,
            citation.sourceType,
            citation.sourceUrl,
            citation.excerpt,
          );
          citationsWritten += 1;
        }
      }
    }
  } catch {
    // Mark the run as failed but keep whatever sections/citations landed.
    try {
      await ctx.db.execute(
        `UPDATE proposals_generation_runs
           SET status = 'failed', section_count = $2, citation_count = $3, completed_at = NOW()
         WHERE id = $1::uuid`,
        runId,
        sectionsWritten,
        citationsWritten,
      );
    } catch {
      /* best-effort status update */
    }
    return err(500, "failed to write proposal sections");
  }

  try {
    await ctx.db.execute(
      `UPDATE proposals_generation_runs
         SET status = 'completed', section_count = $2, citation_count = $3, completed_at = NOW()
       WHERE id = $1::uuid`,
      runId,
      sectionsWritten,
      citationsWritten,
    );
  } catch {
    return err(500, "failed to finalize generation run");
  }

  await ctx.events.publish("proposal.generated", {
    proposal_id: proposalId,
    organization_id: organizationId,
    generation_run_id: runId,
    generated_by_user_id: generatedByUserId,
    sections_written: sectionsWritten,
    citations_written: citationsWritten,
  });

  return ok({
    proposalId,
    organizationId,
    generationRunId: runId,
    sectionsWritten,
    citationsWritten,
  });
}

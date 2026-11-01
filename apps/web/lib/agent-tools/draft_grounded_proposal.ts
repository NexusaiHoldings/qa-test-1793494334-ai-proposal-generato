import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

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

type SentenceCitationInput = {
  sentence: string;
  sourceId?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  excerpt?: string | null;
};

type SectionInput = {
  key: string;
  title?: string | null;
  content?: string | null;
  citations?: SentenceCitationInput[] | null;
};

type ParsedArgs = {
  proposalId: string;
  organizationId: string;
  generatedByUserId: string;
  model?: string | null;
  verticalTemplateId?: string | null;
  sections: SectionInput[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseSections(value: unknown): SectionInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: SectionInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    const key = asString(item.key);
    if (!key) continue;

    const title = asString(item.title);
    const content = asString(item.content);

    const citationsRaw = item.citations;
    let citations: SentenceCitationInput[] | null = null;

    if (Array.isArray(citationsRaw)) {
      citations = citationsRaw
        .filter((c): c is Record<string, unknown> => isRecord(c))
        .map((c) => ({
          sentence: asString(c.sentence) ?? "",
          sourceId: asString(c.sourceId),
          sourceType: asString(c.sourceType),
          sourceUrl: asString(c.sourceUrl),
          excerpt: asString(c.excerpt),
        }))
        .filter((c) => c.sentence.length > 0);
    }

    parsed.push({ key, title, content, citations });
  }

  return parsed;
}

function parseArgs(args: Args): ParsedArgs | null {
  const proposalId = asString(args.proposalId);
  const organizationId = asString(args.organizationId);
  const generatedByUserId = asString(args.generatedByUserId);
  const model = asString(args.model);
  const verticalTemplateId = asString(args.verticalTemplateId);
  const sections = parseSections(args.sections);

  if (!proposalId || !organizationId || !generatedByUserId) {
    return null;
  }

  return {
    proposalId,
    organizationId,
    generatedByUserId,
    model,
    verticalTemplateId,
    sections,
  };
}

function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function handleDraftGroundedProposal(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const parsed = parseArgs(args);
  if (!parsed) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: "proposalId, organizationId, and generatedByUserId are required.",
      },
    } as HandlerResult;
  }

  const { proposalId, organizationId, generatedByUserId, model, verticalTemplateId } = parsed;

  const normalizedSections: SectionInput[] =
    parsed.sections.length > 0
      ? parsed.sections
      : SECTION_KEYS.map((key) => ({
          key,
          title: key.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase()),
          content: "",
          citations: [],
        }));

  const db = (ctx as unknown as { db?: { query?: (sql: string, params?: unknown[]) => Promise<unknown> } }).db;
  if (!db?.query) {
    return {
      ok: false,
      error: {
        code: "db_unavailable",
        message: "Database connection is not available in handler context.",
      },
    } as HandlerResult;
  }

  const runIdResult = (await db.query(
    `INSERT INTO proposals_generation_runs
      (proposal_id, organization_id, generated_by_user_id, model_name, vertical_template_id, status, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'completed', NOW(), NOW())
     RETURNING id`,
    [proposalId, organizationId, generatedByUserId, model ?? null, verticalTemplateId ?? null],
  )) as { rows?: Array<{ id: string }> };

  const runId = runIdResult?.rows?.[0]?.id;
  if (!runId) {
    return {
      ok: false,
      error: {
        code: "write_failed",
        message: "Failed to create generation run record.",
      },
    } as HandlerResult;
  }

  for (let i = 0; i < normalizedSections.length; i += 1) {
    const section = normalizedSections[i];
    const sectionOrder = i + 1;
    const content = section.content ?? "";

    const sectionInsert = (await db.query(
      `INSERT INTO proposals_sections
        (proposal_id, organization_id, generation_run_id, section_key, section_title, section_order, content, created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NOW(), NOW())
       RETURNING id`,
      [
        proposalId,
        organizationId,
        runId,
        section.key,
        section.title ?? null,
        sectionOrder,
        content,
        generatedByUserId,
      ],
    )) as { rows?: Array<{ id: string }> };

    const sectionId = sectionInsert?.rows?.[0]?.id;
    if (!sectionId) {
      continue;
    }

    const sentences = splitSentences(content);
    const citationsBySentence = new Map<string, SentenceCitationInput[]>();
    for (const c of section.citations ?? []) {
      const existing = citationsBySentence.get(c.sentence) ?? [];
      existing.push(c);
      citationsBySentence.set(c.sentence, existing);
    }

    for (let sentenceOrder = 0; sentenceOrder < sentences.length; sentenceOrder += 1) {
      const sentence = sentences[sentenceOrder];
      const explicit = citationsBySentence.get(sentence) ?? [];
      const effective = explicit.length > 0 ? explicit : [{ sentence }];

      for (const cite of effective) {
        await db.query(
          `INSERT INTO proposals_citations
            (proposal_id, organization_id, section_id, sentence_order, sentence_text, source_id, source_type, source_url, source_excerpt, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
          [
            proposalId,
            organizationId,
            sectionId,
            sentenceOrder + 1,
            sentence,
            cite.sourceId ?? null,
            cite.sourceType ?? null,
            cite.sourceUrl ?? null,
            cite.excerpt ?? null,
          ],
        );
      }
    }
  }

  return {
    ok: true,
    data: {
      proposalId,
      organizationId,
      generationRunId: runId,
      sectionsWritten: normalizedSections.length,
    },
  } as HandlerResult;
}

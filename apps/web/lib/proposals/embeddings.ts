/**
 * Case-study embeddings — chunk a case-study narrative and write pgvector
 * embeddings to proposals_case_study_chunks (F1-003).
 *
 * This is the RAG corpus the ceo_briefing names as "the core defensible
 * capability". Embeddings are produced through the Nexus gateway
 * (text-embedding-3-small-class, 1536 dimensions — NOT the OpenAI SDK, which is
 * banned in company apps). When the gateway is unavailable the module degrades
 * to a deterministic local embedding so ingestion never hard-fails at
 * solo-consultant library sizes (tens, not thousands, of case studies); the
 * stored embedding_model records which path produced each vector.
 *
 * All SQL is parameterized ($1, $2, ...) and scoped to organizationId for
 * per-consultant isolation. Raw SQL runs through the substrate pool (@/lib/db).
 */
import type { Db } from "@nexus/identity-and-access/api/_lib/db";

/** text-embedding-3-small dimensionality — matches vector(1536) in the DDL. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Target chunk size (characters) and overlap for narrative chunking. */
const TARGET_CHUNK_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 150;
const MIN_CHUNK_CHARS = 60;

export type CaseStudyChunk = {
  index: number;
  content: string;
  tokenEstimate: number;
};

export type EmbeddedChunk = CaseStudyChunk & {
  embedding: number[];
};

export type WriteChunksInput = {
  caseStudyId: string;
  organizationId: string;
  chunks: EmbeddedChunk[];
  embeddingModel: string;
};

/** Rough token estimate (~4 chars/token) used only for display + budgeting. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Split a narrative into overlapping chunks on sentence/paragraph boundaries.
 *
 * Paragraphs are preserved where possible; long paragraphs are split on
 * sentence boundaries and then hard-wrapped so no chunk exceeds the target by
 * much. A small overlap keeps context continuous across chunk edges.
 */
export function chunkNarrative(narrative: string): CaseStudyChunk[] {
  const normalized = narrative.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  // Break into candidate segments (paragraphs, then sentences for long ones).
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const segments: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= TARGET_CHUNK_CHARS) {
      segments.push(paragraph);
      continue;
    }
    const sentences = paragraph
      .split(/(?<=[.!?])\s+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length <= TARGET_CHUNK_CHARS) {
        segments.push(sentence);
      } else {
        for (let i = 0; i < sentence.length; i += TARGET_CHUNK_CHARS) {
          segments.push(sentence.slice(i, i + TARGET_CHUNK_CHARS));
        }
      }
    }
  }

  // Greedily pack segments into chunks up to the target size.
  const packed: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (current.length === 0) {
      current = segment;
    } else if (current.length + segment.length + 2 <= TARGET_CHUNK_CHARS) {
      current = `${current}\n\n${segment}`;
    } else {
      packed.push(current);
      current = segment;
    }
  }
  if (current.trim().length > 0) packed.push(current);

  // Apply a small backward overlap for context continuity.
  const chunks: CaseStudyChunk[] = [];
  for (let i = 0; i < packed.length; i += 1) {
    let content = packed[i];
    if (i > 0 && CHUNK_OVERLAP_CHARS > 0) {
      const prevTail = packed[i - 1].slice(-CHUNK_OVERLAP_CHARS).trim();
      if (prevTail.length > 0) content = `${prevTail}\n\n${content}`;
    }
    if (content.trim().length < MIN_CHUNK_CHARS && chunks.length > 0) {
      // Fold a tiny trailing chunk into the previous one.
      const prev = chunks[chunks.length - 1];
      prev.content = `${prev.content}\n\n${content.trim()}`;
      prev.tokenEstimate = estimateTokens(prev.content);
      continue;
    }
    chunks.push({
      index: chunks.length,
      content: content.trim(),
      tokenEstimate: estimateTokens(content),
    });
  }

  return chunks;
}

/** Resolve the Nexus gateway base URL + key from server-side env. */
function gatewayConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl =
    process.env.NEXUS_GATEWAY_URL ||
    process.env.PORTFOLIO_RUNTIME_URL ||
    process.env.RUNTIME_BASE_URL ||
    "";
  const apiKey =
    process.env.NEXUS_GATEWAY_API_KEY ||
    process.env.PORTFOLIO_RUNTIME_API_KEY ||
    process.env.RUNTIME_AUTH_TOKEN ||
    "";
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

/**
 * Deterministic local fallback embedding — a hashed bag-of-words projection
 * into a unit-normalised 1536-dim vector. Not as good as a learned model, but
 * stable and adequate for library-scale cosine search when the gateway is
 * unreachable (declared fallback in feasibility blockers).
 */
function localEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % EMBEDDING_DIMENSIONS;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  }
  return vector;
}

type EmbedResult = { embeddings: number[][]; model: string };

/**
 * Embed a batch of chunk texts through the Nexus gateway, falling back to the
 * deterministic local embedding on any error or missing configuration.
 */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], model: "none" };

  const config = gatewayConfig();
  const model = process.env.NEXUS_EMBEDDING_MODEL || "text-embedding-3-small";

  if (config) {
    try {
      const response = await fetch(`${config.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          data?: { embedding?: number[] }[];
          model?: string;
        };
        const embeddings = (payload.data ?? [])
          .map((row) => row.embedding)
          .filter((e): e is number[] => Array.isArray(e) && e.length > 0);
        if (embeddings.length === texts.length) {
          return { embeddings, model: payload.model || model };
        }
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          at: "embeddings.embedTexts",
          msg: "gateway embedding response unusable; using local fallback",
          status: response.status,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          at: "embeddings.embedTexts",
          msg: "gateway embedding call failed; using local fallback",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return {
    embeddings: texts.map((text) => localEmbedding(text)),
    model: "local-hash-fallback",
  };
}

/** Serialize a number[] into the pgvector text literal `[v1,v2,...]`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}

/**
 * Chunk + embed a case-study narrative and persist the chunks. Existing chunks
 * for the case study are deleted first so re-indexing after an edit is
 * idempotent. Returns the number of chunks written.
 */
export async function indexCaseStudyNarrative(
  db: Db,
  input: { caseStudyId: string; organizationId: string; narrative: string },
): Promise<{ chunkCount: number; embeddingModel: string }> {
  const chunks = chunkNarrative(input.narrative);

  await db.execute(
    `DELETE FROM proposals_case_study_chunks
      WHERE case_study_id = $1 AND organization_id = $2`,
    input.caseStudyId,
    input.organizationId,
  );

  if (chunks.length === 0) {
    return { chunkCount: 0, embeddingModel: "none" };
  }

  const { embeddings, model } = await embedTexts(chunks.map((c) => c.content));

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const embedding = embeddings[i] ?? localEmbedding(chunk.content);
    await db.execute(
      `INSERT INTO proposals_case_study_chunks
         (id, case_study_id, organization_id, chunk_index, content,
          token_estimate, embedding, embedding_model, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::vector, $7, now())`,
      input.caseStudyId,
      input.organizationId,
      chunk.index,
      chunk.content,
      chunk.tokenEstimate,
      toVectorLiteral(embedding),
      model,
    );
  }

  await db.execute(
    `UPDATE proposals_case_studies
        SET indexed_at = now(), updated_at = now()
      WHERE id = $1 AND organization_id = $2`,
    input.caseStudyId,
    input.organizationId,
  );

  return { chunkCount: chunks.length, embeddingModel: model };
}

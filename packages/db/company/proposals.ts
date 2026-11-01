/**
 * Company domain schema for the (proposals) carve-out — Practice Profile +
 * Rate Card (F1-002). migrate.ts runs every *_DDL constant against the company
 * database at deploy; the TABLE-REF gate recognizes tables created here.
 */
export const PROPOSALS_DDL = `
CREATE TABLE IF NOT EXISTS proposals_practice_profiles (
  organization_id uuid PRIMARY KEY,
  vertical text,
  methodology_blurb text,
  voice_sample text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals_team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  avatar_file_id uuid,
  full_name text NOT NULL,
  title text,
  credentials text[] NOT NULL DEFAULT '{}'::text[],
  bio_verbatim text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_team_members_org_idx
  ON proposals_team_members (organization_id);

CREATE TABLE IF NOT EXISTS proposals_rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  band_name text NOT NULL,
  pricing_model text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  amount_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_rate_cards_org_idx
  ON proposals_rate_cards (organization_id);
`;

/**
 * Case-Study Library Ingestion (F1-003).
 *
 * The RAG corpus the ceo_briefing names as "the core defensible capability":
 * the consultant drags in old proposals (PDF / DOCX / pasted text); the gateway
 * extracts a structured case study (client — anonymised unless marked public —
 * industry, problem, approach, outcomes with quantified metrics, duration,
 * services); the narrative is chunked and embedded with pgvector into
 * proposals_case_study_chunks.
 *
 * pgvector lives inside the same tenant-isolated company Postgres as the rest of
 * the domain schema (one Postgres, one gateway, one data-processing boundary —
 * see regulatory_risk.data_privacy_exposure). The `vector` extension is enabled
 * here before the chunks table that depends on the `vector` type is created.
 *
 * No CHECK constraints are placed on the free-form text columns (client_name,
 * industry, problem, approach, outcomes, narrative, headline_metric, duration);
 * they hold extracted prose whose shape we cannot constrain.
 */
export const CASE_STUDIES_DDL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS proposals_case_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  source_file_id uuid,
  source_kind text NOT NULL DEFAULT 'upload',
  title text,
  client_name text,
  client_is_public boolean NOT NULL DEFAULT false,
  industry text,
  problem text,
  approach text,
  outcomes text,
  headline_metric text,
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  services text[] NOT NULL DEFAULT '{}'::text[],
  duration text,
  narrative text,
  extraction_confidence real NOT NULL DEFAULT 0,
  extraction_model text,
  pii_flagged boolean NOT NULL DEFAULT false,
  pii_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'ready',
  indexed_at timestamptz,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_case_studies_org_idx
  ON proposals_case_studies (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proposals_case_study_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_study_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  embedding vector(1536),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_case_study_chunks_cs_idx
  ON proposals_case_study_chunks (case_study_id, chunk_index);

CREATE INDEX IF NOT EXISTS proposals_case_study_chunks_org_idx
  ON proposals_case_study_chunks (organization_id);
`;

/**
 * RFP Intake + Requirement Extraction (F1-004).
 *
 * The trigger-event surface: a new RFP lands with a hard deadline. The
 * consultant drops a PDF/DOCX or pastes the text; the text layer is extracted
 * (unpdf / mammoth) and scanned/image-only PDFs are routed to the gateway as a
 * document input for vision extraction. The gateway (Claude Sonnet-class) then
 * produces the structured intake: requirements, weighted evaluation criteria,
 * deadlines, submission format and page limits — each with a per-field
 * confidence and parse_warnings — and each requirement is mapped to a proposal
 * section outline. Regulated-industry RFPs (legal / medical / financial, per the
 * liability_assessor) are flagged on the row so the consultant sees the
 * compliance surface area before drafting.
 *
 * Three tables, all tenant-isolated on organization_id and keyed on UUIDs:
 *   - proposals_rfps            — one row per intake (raw text, status, deadline,
 *                                 submission format, page limit, confidence,
 *                                 parse warnings, regulated flag).
 *   - proposals_rfp_requirements — the extracted requirements, each with a
 *                                 weight bar, confidence pill, highlighted source
 *                                 span, and mapped proposal section.
 *   - proposals_rfp_criteria    — the weighted evaluation criteria the buyer
 *                                 scores against.
 *
 * No CHECK constraints are placed on the free-form text columns (title,
 * raw_text, requirement text, criteria labels, warnings prose); they hold
 * extracted document prose whose shape we cannot constrain.
 */
export const RFPS_DDL = `
CREATE TABLE IF NOT EXISTS proposals_rfps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  source_file_id uuid,
  source_kind text NOT NULL DEFAULT 'upload',
  title text,
  issuer text,
  raw_text text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'parsing',
  submission_format text,
  page_limit integer,
  deadline_at timestamptz,
  deadline_text text,
  parse_confidence real NOT NULL DEFAULT 0,
  parse_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_scanned boolean NOT NULL DEFAULT false,
  is_regulated boolean NOT NULL DEFAULT false,
  regulated_industry text,
  extraction_model text,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_rfps_org_idx
  ON proposals_rfps (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proposals_rfp_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  requirement_index integer NOT NULL DEFAULT 0,
  text text NOT NULL,
  category text,
  weight real NOT NULL DEFAULT 0,
  confidence real NOT NULL DEFAULT 0,
  mandatory boolean NOT NULL DEFAULT false,
  span_start integer,
  span_end integer,
  section_key text,
  section_title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_rfp_requirements_rfp_idx
  ON proposals_rfp_requirements (rfp_id, requirement_index);

CREATE INDEX IF NOT EXISTS proposals_rfp_requirements_org_idx
  ON proposals_rfp_requirements (organization_id);

CREATE TABLE IF NOT EXISTS proposals_rfp_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  criterion_index integer NOT NULL DEFAULT 0,
  label text NOT NULL,
  description text,
  weight real NOT NULL DEFAULT 0,
  confidence real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposals_rfp_criteria_rfp_idx
  ON proposals_rfp_criteria (rfp_id, criterion_index);

CREATE INDEX IF NOT EXISTS proposals_rfp_criteria_org_idx
  ON proposals_rfp_criteria (organization_id);
`;

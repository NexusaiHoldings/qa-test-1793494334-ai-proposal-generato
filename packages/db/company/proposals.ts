export const PROPOSALS_DDL = `
CREATE EXTENSION IF NOT EXISTS vector;

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

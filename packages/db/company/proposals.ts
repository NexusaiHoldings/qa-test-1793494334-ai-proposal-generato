export const PROPOSALS_PRACTICE_DDL = `
CREATE TABLE IF NOT EXISTS proposals_practice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE,
  vertical TEXT NOT NULL,
  methodology TEXT NOT NULL,
  voice_sample TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proposals_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  full_name TEXT NOT NULL,
  role_title TEXT NOT NULL,
  credentials TEXT NOT NULL,
  bio_verbatim TEXT NOT NULL,
  avatar_file_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS proposals_team_members_org_idx
  ON proposals_team_members (organization_id);

CREATE TABLE IF NOT EXISTS proposals_rate_card_bands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  cadence TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS proposals_rate_card_bands_org_idx
  ON proposals_rate_card_bands (organization_id);
`;

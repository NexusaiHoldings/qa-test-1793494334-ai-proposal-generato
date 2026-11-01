import { sql } from "@vercel/postgres";

export type PracticeVertical = "management" | "marketing" | "it" | "hr";

export type TeamMember = {
  id: string;
  organizationId: string;
  avatarFileId: string | null;
  fullName: string;
  title: string | null;
  credentials: string[];
  bioVerbatim: string;
  createdAt: string;
  updatedAt: string;
};

export type RateBand = {
  id: string;
  organizationId: string;
  bandName: string;
  pricingModel: "hourly" | "day" | "fixed_fee";
  currency: string;
  amountCents: number;
  createdAt: string;
  updatedAt: string;
};

export type PracticeProfile = {
  organizationId: string;
  vertical: PracticeVertical | null;
  methodologyBlurb: string | null;
  voiceSample: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PracticeSettings = {
  profile: PracticeProfile | null;
  team: TeamMember[];
  rates: RateBand[];
  completionPercent: number;
};

function computeCompletion(profile: PracticeProfile | null, teamCount: number, ratesCount: number): number {
  let score = 0;
  if (teamCount > 0) score += 25;
  if (ratesCount > 0) score += 25;
  if (profile?.vertical) score += 25;
  if (profile?.methodologyBlurb && profile.methodologyBlurb.trim().length > 0) score += 12.5;
  if (profile?.voiceSample && profile.voiceSample.trim().length > 0) score += 12.5;
  return Math.round(score);
}

export async function getPracticeSettings(organizationId: string): Promise<PracticeSettings> {
  const profileResult = await sql<PracticeProfile>`
    SELECT
      organization_id as "organizationId",
      vertical,
      methodology_blurb as "methodologyBlurb",
      voice_sample as "voiceSample",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM proposals_practice_profiles
    WHERE organization_id = ${organizationId}
    LIMIT 1
  `;

  const teamResult = await sql<TeamMember>`
    SELECT
      id,
      organization_id as "organizationId",
      avatar_file_id as "avatarFileId",
      full_name as "fullName",
      title,
      credentials,
      bio_verbatim as "bioVerbatim",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM proposals_team_members
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `;

  const ratesResult = await sql<RateBand>`
    SELECT
      id,
      organization_id as "organizationId",
      band_name as "bandName",
      pricing_model as "pricingModel",
      currency,
      amount_cents as "amountCents",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM proposals_rate_cards
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `;

  const profile = profileResult.rows[0] ?? null;
  const team = teamResult.rows;
  const rates = ratesResult.rows;

  return {
    profile,
    team,
    rates,
    completionPercent: computeCompletion(profile, team.length, rates.length),
  };
}

export type UpsertProfileInput = {
  organizationId: string;
  vertical: PracticeVertical | null;
  methodologyBlurb: string | null;
  voiceSample: string | null;
};

export async function upsertPracticeProfile(input: UpsertProfileInput): Promise<void> {
  await sql`
    INSERT INTO proposals_practice_profiles (
      organization_id,
      vertical,
      methodology_blurb,
      voice_sample
    )
    VALUES (
      ${input.organizationId},
      ${input.vertical},
      ${input.methodologyBlurb},
      ${input.voiceSample}
    )
    ON CONFLICT (organization_id)
    DO UPDATE SET
      vertical = EXCLUDED.vertical,
      methodology_blurb = EXCLUDED.methodology_blurb,
      voice_sample = EXCLUDED.voice_sample,
      updated_at = now()
  `;
}

export type UpsertTeamMemberInput = {
  organizationId: string;
  id?: string;
  avatarFileId: string | null;
  fullName: string;
  title: string | null;
  credentials: string[];
  bioVerbatim: string;
};

export async function upsertTeamMember(input: UpsertTeamMemberInput): Promise<void> {
  if (input.id) {
    await sql`
      UPDATE proposals_team_members
      SET
        avatar_file_id = ${input.avatarFileId},
        full_name = ${input.fullName},
        title = ${input.title},
        credentials = ${input.credentials},
        bio_verbatim = ${input.bioVerbatim},
        updated_at = now()
      WHERE id = ${input.id}
        AND organization_id = ${input.organizationId}
    `;
    return;
  }

  await sql`
    INSERT INTO proposals_team_members (
      organization_id,
      avatar_file_id,
      full_name,
      title,
      credentials,
      bio_verbatim
    ) VALUES (
      ${input.organizationId},
      ${input.avatarFileId},
      ${input.fullName},
      ${input.title},
      ${input.credentials},
      ${input.bioVerbatim}
    )
  `;
}

export async function deleteTeamMember(organizationId: string, id: string): Promise<void> {
  await sql`
    DELETE FROM proposals_team_members
    WHERE id = ${id}
      AND organization_id = ${organizationId}
  `;
}

export type UpsertRateBandInput = {
  organizationId: string;
  id?: string;
  bandName: string;
  pricingModel: "hourly" | "day" | "fixed_fee";
  currency: string;
  amountCents: number;
};

export async function upsertRateBand(input: UpsertRateBandInput): Promise<void> {
  if (input.id) {
    await sql`
      UPDATE proposals_rate_cards
      SET
        band_name = ${input.bandName},
        pricing_model = ${input.pricingModel},
        currency = ${input.currency},
        amount_cents = ${input.amountCents},
        updated_at = now()
      WHERE id = ${input.id}
        AND organization_id = ${input.organizationId}
    `;
    return;
  }

  await sql`
    INSERT INTO proposals_rate_cards (
      organization_id,
      band_name,
      pricing_model,
      currency,
      amount_cents
    ) VALUES (
      ${input.organizationId},
      ${input.bandName},
      ${input.pricingModel},
      ${input.currency},
      ${input.amountCents}
    )
  `;
}

export async function deleteRateBand(organizationId: string, id: string): Promise<void> {
  await sql`
    DELETE FROM proposals_rate_cards
    WHERE id = ${id}
      AND organization_id = ${organizationId}
  `;
}

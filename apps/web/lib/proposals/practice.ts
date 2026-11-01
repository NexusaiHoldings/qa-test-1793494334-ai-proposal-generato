/**
 * Practice Profile + Rate Card — server-side data access.
 *
 * The consultant's verified source of truth that proposal generation is allowed
 * to quote from: team member bios (stored + injected verbatim, never
 * paraphrased), a rate card (hourly / day / fixed-fee bands), the practice's
 * vertical, a methodology blurb, and a voice sample that steers tone.
 *
 * All queries are parameterized ($1, $2, ...) and scoped to organizationId for
 * per-consultant isolation. Raw SQL runs through the substrate `pg` pool
 * (@/lib/db buildDb); no ORM.
 */
import { buildDb } from "@/lib/db";

export type PracticeVertical = "management" | "marketing" | "it" | "hr";
export type PricingModel = "hourly" | "day" | "fixed_fee";

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
  pricingModel: PricingModel;
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

/**
 * Profile completeness drives the first-run onboarding checklist. Weighting:
 * team (25) + rates (25) + vertical (25) + methodology (12.5) + voice (12.5).
 */
function computeCompletion(
  profile: PracticeProfile | null,
  teamCount: number,
  ratesCount: number,
): number {
  let score = 0;
  if (teamCount > 0) score += 25;
  if (ratesCount > 0) score += 25;
  if (profile?.vertical) score += 25;
  if (profile?.methodologyBlurb && profile.methodologyBlurb.trim().length > 0) score += 12.5;
  if (profile?.voiceSample && profile.voiceSample.trim().length > 0) score += 12.5;
  return Math.round(score);
}

export async function getPracticeSettings(organizationId: string): Promise<PracticeSettings> {
  const db = buildDb();

  const profileRows = await db.query<PracticeProfile>(
    `SELECT
        organization_id AS "organizationId",
        vertical,
        methodology_blurb AS "methodologyBlurb",
        voice_sample AS "voiceSample",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM proposals_practice_profiles
      WHERE organization_id = $1
      LIMIT 1`,
    organizationId,
  );

  const teamRows = await db.query<TeamMember>(
    `SELECT
        id,
        organization_id AS "organizationId",
        avatar_file_id AS "avatarFileId",
        full_name AS "fullName",
        title,
        credentials,
        bio_verbatim AS "bioVerbatim",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM proposals_team_members
      WHERE organization_id = $1
      ORDER BY created_at ASC`,
    organizationId,
  );

  const rateRows = await db.query<RateBand>(
    `SELECT
        id,
        organization_id AS "organizationId",
        band_name AS "bandName",
        pricing_model AS "pricingModel",
        currency,
        amount_cents AS "amountCents",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM proposals_rate_cards
      WHERE organization_id = $1
      ORDER BY created_at ASC`,
    organizationId,
  );

  const profile = profileRows[0] ?? null;
  const team = teamRows.map((row) => ({
    ...row,
    credentials: Array.isArray(row.credentials) ? row.credentials : [],
  }));
  const rates = rateRows.map((row) => ({
    ...row,
    amountCents: Number(row.amountCents),
  }));

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
  const db = buildDb();
  await db.execute(
    `INSERT INTO proposals_practice_profiles (
        organization_id,
        vertical,
        methodology_blurb,
        voice_sample
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id)
     DO UPDATE SET
        vertical = EXCLUDED.vertical,
        methodology_blurb = EXCLUDED.methodology_blurb,
        voice_sample = EXCLUDED.voice_sample,
        updated_at = now()`,
    input.organizationId,
    input.vertical,
    input.methodologyBlurb,
    input.voiceSample,
  );
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
  const db = buildDb();

  if (input.id) {
    await db.execute(
      `UPDATE proposals_team_members
          SET avatar_file_id = $1,
              full_name = $2,
              title = $3,
              credentials = $4,
              bio_verbatim = $5,
              updated_at = now()
        WHERE id = $6
          AND organization_id = $7`,
      input.avatarFileId,
      input.fullName,
      input.title,
      input.credentials,
      input.bioVerbatim,
      input.id,
      input.organizationId,
    );
    return;
  }

  await db.execute(
    `INSERT INTO proposals_team_members (
        organization_id,
        avatar_file_id,
        full_name,
        title,
        credentials,
        bio_verbatim
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    input.organizationId,
    input.avatarFileId,
    input.fullName,
    input.title,
    input.credentials,
    input.bioVerbatim,
  );
}

export async function deleteTeamMember(organizationId: string, id: string): Promise<void> {
  const db = buildDb();
  await db.execute(
    `DELETE FROM proposals_team_members
      WHERE id = $1
        AND organization_id = $2`,
    id,
    organizationId,
  );
}

export type UpsertRateBandInput = {
  organizationId: string;
  id?: string;
  bandName: string;
  pricingModel: PricingModel;
  currency: string;
  amountCents: number;
};

export async function upsertRateBand(input: UpsertRateBandInput): Promise<void> {
  const db = buildDb();

  if (input.id) {
    await db.execute(
      `UPDATE proposals_rate_cards
          SET band_name = $1,
              pricing_model = $2,
              currency = $3,
              amount_cents = $4,
              updated_at = now()
        WHERE id = $5
          AND organization_id = $6`,
      input.bandName,
      input.pricingModel,
      input.currency,
      input.amountCents,
      input.id,
      input.organizationId,
    );
    return;
  }

  await db.execute(
    `INSERT INTO proposals_rate_cards (
        organization_id,
        band_name,
        pricing_model,
        currency,
        amount_cents
     ) VALUES ($1, $2, $3, $4, $5)`,
    input.organizationId,
    input.bandName,
    input.pricingModel,
    input.currency,
    input.amountCents,
  );
}

export async function deleteRateBand(organizationId: string, id: string): Promise<void> {
  const db = buildDb();
  await db.execute(
    `DELETE FROM proposals_rate_cards
      WHERE id = $1
        AND organization_id = $2`,
    id,
    organizationId,
  );
}

import { sql } from "@vercel/postgres";

export type PracticeProfile = {
  id: string;
  organizationId: string;
  vertical: string;
  methodology: string;
  voiceSample: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type TeamMember = {
  id: string;
  organizationId: string;
  fullName: string;
  roleTitle: string;
  credentials: string;
  bioVerbatim: string;
  avatarFileId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RateBand = {
  id: string;
  organizationId: string;
  name: string;
  cadence: string;
  amount: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

export type PracticeProfileInput = {
  vertical: string;
  methodology: string;
  voiceSample: string;
};

export type TeamMemberInput = {
  fullName: string;
  roleTitle: string;
  credentials: string;
  bioVerbatim: string;
  avatarFileId?: string | null;
};

export type RateBandInput = {
  id?: string | null;
  name: string;
  cadence: string;
  amount: number;
  currency: string;
};

export async function getPracticeProfile(organizationId: string): Promise<PracticeProfile | null> {
  const result = await sql<PracticeProfile>`
    SELECT
      id,
      organization_id AS "organizationId",
      vertical,
      methodology,
      voice_sample AS "voiceSample",
      created_by AS "createdBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM proposals_practice_profiles
    WHERE organization_id = ${organizationId}
    LIMIT 1
  `;
  return result.rows[0] ?? null;
}

export async function createPracticeProfile(
  organizationId: string,
  createdBy: string,
  input: PracticeProfileInput
): Promise<boolean> {
  const result = await sql`
    INSERT INTO proposals_practice_profiles (
      organization_id, vertical, methodology, voice_sample, created_by
    )
    VALUES (${organizationId}, ${input.vertical}, ${input.methodology}, ${input.voiceSample}, ${createdBy})
    ON CONFLICT (organization_id) DO NOTHING
  `;
  return (result.rowCount ?? 0) > 0;
}

export async function updatePracticeProfile(
  organizationId: string,
  input: PracticeProfileInput
): Promise<void> {
  await sql`
    UPDATE proposals_practice_profiles
    SET
      vertical = ${input.vertical},
      methodology = ${input.methodology},
      voice_sample = ${input.voiceSample},
      updated_at = NOW()
    WHERE organization_id = ${organizationId}
  `;
}

export async function listTeamMembers(organizationId: string): Promise<TeamMember[]> {
  const result = await sql<TeamMember>`
    SELECT
      id,
      organization_id AS "organizationId",
      full_name AS "fullName",
      role_title AS "roleTitle",
      credentials,
      bio_verbatim AS "bioVerbatim",
      avatar_file_id AS "avatarFileId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM proposals_team_members
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `;
  return result.rows;
}

export async function createTeamMember(organizationId: string, input: TeamMemberInput): Promise<void> {
  await sql`
    INSERT INTO proposals_team_members (
      organization_id, full_name, role_title, credentials, bio_verbatim, avatar_file_id
    )
    VALUES (
      ${organizationId},
      ${input.fullName},
      ${input.roleTitle},
      ${input.credentials},
      ${input.bioVerbatim},
      ${input.avatarFileId ?? null}
    )
  `;
}

export async function deleteTeamMember(organizationId: string, memberId: string): Promise<void> {
  await sql`
    DELETE FROM proposals_team_members
    WHERE organization_id = ${organizationId}
      AND id = ${memberId}
  `;
}

export async function listRateCardBands(organizationId: string): Promise<RateBand[]> {
  const result = await sql<RateBand>`
    SELECT
      id,
      organization_id AS "organizationId",
      name,
      cadence,
      amount,
      currency,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM proposals_rate_card_bands
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `;
  return result.rows;
}

export async function upsertRateCardBand(organizationId: string, input: RateBandInput): Promise<void> {
  if (input.id) {
    await sql`
      UPDATE proposals_rate_card_bands
      SET
        name = ${input.name},
        cadence = ${input.cadence},
        amount = ${input.amount},
        currency = ${input.currency},
        updated_at = NOW()
      WHERE id = ${input.id}
        AND organization_id = ${organizationId}
    `;
    return;
  }

  await sql`
    INSERT INTO proposals_rate_card_bands (organization_id, name, cadence, amount, currency)
    VALUES (${organizationId}, ${input.name}, ${input.cadence}, ${input.amount}, ${input.currency})
  `;
}

export function getPracticeCompleteness(args: {
  profile: PracticeProfile | null;
  teamMembers: TeamMember[];
  rateBands: RateBand[];
}): { completed: number; total: number; percent: number } {
  const total = 4;
  let completed = 0;

  if (args.teamMembers.length > 0) {
    completed += 1;
  }

  if (args.rateBands.length > 0) {
    completed += 1;
  }

  if (args.profile?.voiceSample?.trim()) {
    completed += 1;
  }

  if (args.profile?.vertical?.trim() && args.profile?.methodology?.trim()) {
    completed += 1;
  }

  const percent = Math.round((completed / total) * 100);
  return { completed, total, percent };
}

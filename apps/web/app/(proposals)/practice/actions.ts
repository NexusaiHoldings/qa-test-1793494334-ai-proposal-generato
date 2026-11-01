"use server";

import { revalidatePath } from "next/cache";
import {
  createPracticeProfile,
  createTeamMember,
  deleteTeamMember,
  listTeamMembers,
  listRateCardBands,
  updatePracticeProfile,
  upsertRateCardBand,
  type PracticeProfileInput,
  type TeamMemberInput,
  type RateBandInput,
} from "@/lib/proposals/practice";
import { requireOrganizationContext } from "@/lib/proposals/access";

type ActionResult = {
  ok: boolean;
  error?: string;
};

function parseOptionalString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRequiredString(value: FormDataEntryValue | null, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Missing required field: ${field}`);
  }
  const trimmed: string = value.trim();
  if (!trimmed) {
    throw new Error(`Missing required field: ${field}`);
  }
  return trimmed;
}

export async function savePracticeProfileAction(formData: FormData): Promise<ActionResult> {
  try {
    const { organizationId, userId } = await requireOrganizationContext();
    const methodology: string = parseRequiredString(formData.get("methodology"), "methodology");
    const voiceSample: string = parseRequiredString(formData.get("voiceSample"), "voiceSample");
    const vertical: string = parseRequiredString(formData.get("vertical"), "vertical");

    const payload: PracticeProfileInput = {
      methodology,
      voiceSample,
      vertical,
    };

    const existing = await createPracticeProfile(organizationId, userId, payload);
    if (!existing) {
      await updatePracticeProfile(organizationId, payload);
    }

    revalidatePath("/practice");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to save profile.",
    };
  }
}

export async function addTeamMemberAction(formData: FormData): Promise<ActionResult> {
  try {
    const { organizationId } = await requireOrganizationContext();

    const payload: TeamMemberInput = {
      fullName: parseRequiredString(formData.get("fullName"), "fullName"),
      roleTitle: parseRequiredString(formData.get("roleTitle"), "roleTitle"),
      credentials: parseRequiredString(formData.get("credentials"), "credentials"),
      bioVerbatim: parseRequiredString(formData.get("bioVerbatim"), "bioVerbatim"),
      avatarFileId: parseOptionalString(formData.get("avatarFileId")),
    };

    await createTeamMember(organizationId, payload);
    revalidatePath("/practice");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to add team member.",
    };
  }
}

export async function removeTeamMemberAction(formData: FormData): Promise<ActionResult> {
  try {
    const { organizationId } = await requireOrganizationContext();
    const memberId: string = parseRequiredString(formData.get("memberId"), "memberId");

    await deleteTeamMember(organizationId, memberId);
    revalidatePath("/practice");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to remove team member.",
    };
  }
}

export async function saveRateBandAction(formData: FormData): Promise<ActionResult> {
  try {
    const { organizationId } = await requireOrganizationContext();
    const name: string = parseRequiredString(formData.get("name"), "name");
    const cadence: string = parseRequiredString(formData.get("cadence"), "cadence");
    const amountRaw: string = parseRequiredString(formData.get("amount"), "amount");
    const amount: number = Number(amountRaw);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Amount must be a non-negative number.");
    }

    const payload: RateBandInput = {
      id: parseOptionalString(formData.get("id")),
      name,
      cadence,
      amount,
      currency: parseOptionalString(formData.get("currency")) ?? "USD",
    };

    await upsertRateCardBand(organizationId, payload);
    revalidatePath("/practice");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to save rate band.",
    };
  }
}

export async function preloadPracticeDataAction(): Promise<{
  teamMembers: Awaited<ReturnType<typeof listTeamMembers>>;
  rateCardBands: Awaited<ReturnType<typeof listRateCardBands>>;
}> {
  const { organizationId } = await requireOrganizationContext();
  const [teamMembers, rateCardBands] = await Promise.all([
    listTeamMembers(organizationId),
    listRateCardBands(organizationId),
  ]);
  return { teamMembers, rateCardBands };
}

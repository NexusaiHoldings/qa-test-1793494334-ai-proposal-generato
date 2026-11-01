"use server";

import { revalidatePath } from "next/cache";
import { requireProposalAccess } from "@/lib/proposals/access";
import {
  deleteRateBand,
  deleteTeamMember,
  upsertPracticeProfile,
  upsertRateBand,
  upsertTeamMember,
  type PracticeVertical,
} from "@/lib/proposals/practice";

function asNullable(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export async function saveProfileAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const verticalRaw = asNullable(formData.get("vertical"));
  const vertical = (verticalRaw as PracticeVertical | null) ?? null;

  await upsertPracticeProfile({
    organizationId,
    vertical,
    methodologyBlurb: asNullable(formData.get("methodologyBlurb")),
    voiceSample: asNullable(formData.get("voiceSample")),
  });

  revalidatePath("/practice");
}

export async function saveTeamMemberAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const credentialsRaw = asNullable(formData.get("credentials"));
  const credentials = credentialsRaw ? credentialsRaw.split(",").map((c) => c.trim()).filter(Boolean) : [];

  const fullName = asNullable(formData.get("fullName"));
  const bioVerbatim = asNullable(formData.get("bioVerbatim"));

  if (!fullName || !bioVerbatim) {
    throw new Error("Name and bio are required");
  }

  await upsertTeamMember({
    organizationId,
    id: asNullable(formData.get("id")) ?? undefined,
    avatarFileId: asNullable(formData.get("avatarFileId")),
    fullName,
    title: asNullable(formData.get("title")),
    credentials,
    bioVerbatim,
  });

  revalidatePath("/practice");
}

export async function deleteTeamMemberAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("Missing member id");
  await deleteTeamMember(organizationId, id);
  revalidatePath("/practice");
}

export async function saveRateBandAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();

  const bandName = asNullable(formData.get("bandName"));
  const pricingModel = asNullable(formData.get("pricingModel")) as "hourly" | "day" | "fixed_fee" | null;
  const currency = (asNullable(formData.get("currency")) ?? "USD").toUpperCase();
  const amount = Number(asNullable(formData.get("amount")));
  const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : NaN;

  if (!bandName || !pricingModel || Number.isNaN(amountCents)) {
    throw new Error("Invalid rate band input");
  }

  await upsertRateBand({
    organizationId,
    id: asNullable(formData.get("id")) ?? undefined,
    bandName,
    pricingModel,
    currency,
    amountCents,
  });

  revalidatePath("/practice");
}

export async function deleteRateBandAction(formData: FormData): Promise<void> {
  const { organizationId } = await requireProposalAccess();
  const id = asNullable(formData.get("id"));
  if (!id) throw new Error("Missing rate id");
  await deleteRateBand(organizationId, id);
  revalidatePath("/practice");
}

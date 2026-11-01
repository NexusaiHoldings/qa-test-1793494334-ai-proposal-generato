import { getServerSession } from "@nexus/identity-and-access";
import { getActiveOrganizationForUser } from "@nexus/organizations-and-teams";

export type OrganizationContext = {
  userId: string;
  organizationId: string;
};

export async function requireOrganizationContext(): Promise<OrganizationContext> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const org = await getActiveOrganizationForUser(session.user.id);
  if (!org?.id) {
    throw new Error("No active organization found.");
  }

  return {
    userId: session.user.id,
    organizationId: org.id,
  };
}

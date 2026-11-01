/**
 * Navigation configuration for the substrate <TopNav /> strip.
 *
 * The substrate reads NAV_CONFIG to render the sticky top navigation.
 * Shape contract (do not change): NavLink / NavGroup / NavConfig types
 * and a NAV_CONFIG object literal with `primary` + `groups` keys.
 *
 * Entries marked `adminOnly` are hidden from the public nav by the
 * nav generator (and by the getVisibleNav helper below).
 */

export interface NavLink {
  /** Absolute in-app href the nav item routes to. */
  href: string;
  /** Display label rendered in the nav strip. */
  label: string;
  /** When true, only rendered for admin users. */
  adminOnly?: boolean;
}

export interface NavGroup {
  /** Group heading shown for the dropdown/section. */
  label: string;
  /** Links within the group. */
  links: NavLink[];
  /** When true, the whole group is admin-only. */
  adminOnly?: boolean;
}

export interface NavConfig {
  /** Top-level links rendered directly in the nav strip. */
  primary: NavLink[];
  /** Grouped links rendered as dropdown sections. */
  groups: NavGroup[];
}

export const NAV_CONFIG: NavConfig = {
  primary: [
    { href: "/rfps", label: "RFPs" },
    { href: "/proposals", label: "Proposals" },
    { href: "/library", label: "Case Studies" },
  ],
  groups: [
    {
      label: "Practice",
      links: [
        { href: "/practice", label: "Practice Profile" },
        { href: "/settings/data", label: "Data & Retention" },
      ],
    },
    {
      label: "Admin",
      adminOnly: true,
      links: [
        {
          href: "/admin/generation-qa",
          label: "Generation QA",
          adminOnly: true,
        },
      ],
    },
  ],
};

/**
 * Returns the nav config filtered for the given viewer. Admin-only
 * links and groups are stripped for non-admin viewers; groups left
 * with no visible links are dropped entirely.
 */
export function getVisibleNav(isAdmin: boolean): NavConfig {
  const primary: NavLink[] = NAV_CONFIG.primary.filter(
    (link: NavLink) => !link.adminOnly || isAdmin,
  );

  const groups: NavGroup[] = NAV_CONFIG.groups
    .filter((group: NavGroup) => !group.adminOnly || isAdmin)
    .map((group: NavGroup) => ({
      ...group,
      links: group.links.filter(
        (link: NavLink) => !link.adminOnly || isAdmin,
      ),
    }))
    .filter((group: NavGroup) => group.links.length > 0);

  return { primary, groups };
}

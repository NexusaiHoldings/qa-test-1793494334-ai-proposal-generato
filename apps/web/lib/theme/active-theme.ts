/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#141b2d",
    "accent": "#1f4fd8",
    "border": "#d9dfeb",
    "danger": "#b42318",
    "success": "#157347",
    "surface": "#f5f7fb",
    "textMuted": "#4f5a72",
    "accentText": "#ffffff",
    "surfaceAlt": "#eaeef6",
    "borderStrong": "#b8c2d6"
  },
  "shape": {
    "radius": 6
  }
};

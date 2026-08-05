/**
 * Pre-start vehicle inspection checklist (spec §7.6).
 * Posted as `check_<key>` = "on" and stored as jsonb on the inspection.
 */
export const CHECKLIST_KEYS = [
  "tyres", "lights", "brakes", "fluids", "load_restraints", "first_aid", "cleanliness",
] as const;

export const CHECKLIST_LABELS: Record<(typeof CHECKLIST_KEYS)[number], string> = {
  tyres: "Tyres and wheels",
  lights: "Lights and indicators",
  brakes: "Brakes",
  fluids: "Oil, coolant and washer fluid",
  load_restraints: "Load restraints",
  first_aid: "First aid kit and extinguisher",
  cleanliness: "Cargo area clean and dry",
};

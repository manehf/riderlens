import type { GarageState, PermissionLevel } from "../types/domain";

export function createSetupShareText(garage: GarageState, permission: PermissionLevel = "view"): string {
  const { bike, setup, suspension, cockpit, tires, services } = garage;
  const latestService = services[0];

  return [
    `RiderLens setup sheet (${permission} access)`,
    `${bike.year} ${bike.brand} ${bike.model} - ${bike.name}`,
    "",
    `Setup: ${setup.name}`,
    `Terrain: ${setup.terrainType}`,
    `Rider with gear: ${setup.riderWeightWithGear} kg`,
    "",
    "Suspension",
    `Fork: ${suspension.forkModel}`,
    `Fork pressure: ${suspension.forkPressure} psi`,
    `Fork sag: ${suspension.forkSagPercent}%`,
    `Fork rebound: ${suspension.forkReboundClicks} clicks`,
    "",
    "Tires",
    `Front: ${tires.frontTirePressure} psi / ${tires.frontTireWidth} in`,
    `Rear: ${tires.rearTirePressure} psi / ${tires.rearTireWidth} in`,
    "",
    "Cockpit",
    `Bar width: ${cockpit.barWidth} mm`,
    `Stem: ${cockpit.stemLength} mm`,
    `Brake lever angle: ${cockpit.brakeLeverAngle} deg`,
    "",
    "Feedback",
    setup.notes,
    "",
    latestService ? `Last service: ${latestService.serviceType} on ${latestService.serviceDate}` : "No service record yet"
  ].join("\n");
}

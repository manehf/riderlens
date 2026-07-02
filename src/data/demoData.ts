import type { GarageState } from "../types/domain";

const now = new Date("2026-06-29T18:00:00.000Z").toISOString();

export const demoGarage: GarageState = {
  bike: {
    id: "bike-demo-01",
    userId: "demo-user",
    name: "Park Bike",
    brand: "Transition",
    model: "PBJ",
    year: 2025,
    discipline: "Dirt jump / bike park",
    createdAt: now
  },
  setup: {
    id: "setup-demo-01",
    bikeId: "bike-demo-01",
    name: "Bike park baseline",
    terrainType: "Bike park",
    ridingStyle: "Regular jumps",
    riderWeightWithGear: 78,
    notes: "Stable on takeoff, slightly harsh on repeated landings.",
    createdAt: now,
    updatedAt: now
  },
  suspension: {
    id: "susp-demo-01",
    bikeSetupId: "setup-demo-01",
    forkModel: "RockShox Pike DJ",
    shockModel: "Hardtail",
    forkPressure: 86,
    shockPressure: 0,
    forkSagPercent: 12,
    shockSagPercent: 0,
    forkReboundClicks: 7,
    shockReboundClicks: 0,
    forkLscClicks: 5,
    forkHscClicks: 0,
    shockLscClicks: 0,
    shockHscClicks: 0,
    forkTokens: 2,
    shockTokens: 0,
    notes: "If landings feel harsh, reduce fork pressure by 2 psi or open LSC 1 click."
  },
  cockpit: {
    id: "cockpit-demo-01",
    bikeSetupId: "setup-demo-01",
    barWidth: 760,
    stemLength: 40,
    stemSpacers: 10,
    barRollAngle: 3,
    brakeLeverAngle: 32,
    saddleHeight: 705,
    saddleAngle: -2,
    notes: "Levers aligned for standing position."
  },
  tires: {
    id: "tire-demo-01",
    bikeSetupId: "setup-demo-01",
    frontTireModel: "Maxxis DTH",
    rearTireModel: "Maxxis DTH",
    frontTirePressure: 28,
    rearTirePressure: 30,
    frontTireWidth: 2.3,
    rearTireWidth: 2.3,
    conditions: "Dry hardpack",
    notes: "Increase 2 psi if casing rolls on lips."
  },
  services: [
    {
      id: "service-demo-01",
      bikeId: "bike-demo-01",
      serviceType: "Fork lower service",
      serviceDate: "2026-06-02",
      odometerOrHours: 34,
      shopName: "Trailside Workshop",
      mechanicName: "Marta",
      notes: "Fresh seals and bath oil.",
      nextDueAt: "2026-08-02"
    }
  ],
  measurements: [
    {
      id: "measure-demo-01",
      bikeId: "bike-demo-01",
      bikeSetupId: "setup-demo-01",
      measurementType: "Brake lever angle",
      value: 32,
      unit: "deg",
      notes: "Measured with phone along lever blade.",
      createdAt: now
    }
  ]
};

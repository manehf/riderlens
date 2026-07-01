import type { GarageState, RideSession } from "../types/domain";

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

export const demoSessions: RideSession[] = [
  {
    id: "session-demo-01",
    userId: "demo-user",
    skillType: "regular_jump",
    status: "complete",
    source: "video_upload",
    title: "Regular jump baseline",
    createdAt: now,
    video: {
      id: "video-demo-01",
      sessionId: "session-demo-01",
      rawVideoUri: "demo://regular-jump",
      annotatedVideoUri: "demo://regular-jump-annotated",
      durationSeconds: 6.4,
      fps: 60,
      trimStartSeconds: 1.0,
      trimEndSeconds: 5.2,
      cropPreset: "full_side_view",
      createdAt: now
    },
    job: {
      id: "job-demo-01",
      sessionId: "session-demo-01",
      status: "completed",
      progress: 1,
      startedAt: now,
      finishedAt: now
    },
    metrics: [
      {
        id: "metric-demo-approach",
        sessionId: "session-demo-01",
        phase: "approach",
        frameTime: 1.2,
        torsoAngle: 54,
        hipAngle: 118,
        kneeAngle: 141,
        elbowAngle: 155,
        bikePitchAngle: 2,
        confidence: 0.84
      },
      {
        id: "metric-demo-takeoff",
        sessionId: "session-demo-01",
        phase: "takeoff",
        frameTime: 2.4,
        torsoAngle: 48,
        hipAngle: 104,
        kneeAngle: 128,
        elbowAngle: 169,
        bikePitchAngle: -6,
        confidence: 0.82
      },
      {
        id: "metric-demo-landing",
        sessionId: "session-demo-01",
        phase: "landing",
        frameTime: 4.9,
        torsoAngle: 43,
        hipAngle: 96,
        kneeAngle: 112,
        elbowAngle: 138,
        bikePitchAngle: -3,
        confidence: 0.78
      }
    ],
    report: {
      id: "report-demo-01",
      sessionId: "session-demo-01",
      summary:
        "Your takeoff is stable, but your arms appear to extend slightly before your legs. That timing can make the front wheel drop early.",
      strengths: [
        "Good side-view filming makes the takeoff and landing phases readable.",
        "Bike pitch stays controlled through the middle of the jump."
      ],
      improvements: [
        "Compress a little earlier before the lip.",
        "Drive through legs and arms together instead of reaching with the arms first.",
        "Aim to land with hips centered over the bike rather than behind the rear axle."
      ],
      drills: [
        "Do 5 slow pump-throughs on the lip without jumping.",
        "Practice matched arm-and-leg extension on a small table.",
        "Film again from the same side angle to compare timing."
      ],
      createdAt: now
    }
  }
];

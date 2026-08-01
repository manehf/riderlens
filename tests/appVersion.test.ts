import { describe, expect, it } from "vitest";

import {
  compareAppVersions,
  evaluateAppUpdate,
  parseAppVersionConfig,
  type AppVersionConfig
} from "../src/services/appVersion";

const config: AppVersionConfig = {
  platform: "ios",
  latestVersion: "1.2.0",
  minimumSupportedVersion: "1.0.0",
  storeUrl: "https://apps.apple.com/app/id123",
  message: "A new version is available."
};

describe("app version comparison", () => {
  it("compares numeric components rather than strings", () => {
    expect(compareAppVersions("1.0.9", "1.0.10")).toBe(-1);
    expect(compareAppVersions("1.10.0", "1.2.0")).toBe(1);
  });

  it("treats omitted trailing components as zero", () => {
    expect(compareAppVersions("1.0", "1.0.0")).toBe(0);
  });
});

describe("app update evaluation", () => {
  it("returns an optional update below latest but above minimum", () => {
    expect(evaluateAppUpdate("1.1.0", config)).toMatchObject({
      latestVersion: "1.2.0",
      required: false
    });
  });

  it("requires an update below the supported minimum", () => {
    expect(evaluateAppUpdate("0.9.9", config)).toMatchObject({
      minimumSupportedVersion: "1.0.0",
      required: true
    });
  });

  it("returns no notice for the latest version", () => {
    expect(evaluateAppUpdate("1.2.0", config)).toBeUndefined();
  });

  it("rejects malformed worker configuration", () => {
    expect(
      parseAppVersionConfig(
        {
          ...config,
          latestVersion: "latest",
          storeUrl: "javascript:alert(1)"
        },
        "ios"
      )
    ).toBeUndefined();
  });

  it("rejects a minimum version above the latest release", () => {
    expect(
      parseAppVersionConfig(
        {
          ...config,
          latestVersion: "1.2.0",
          minimumSupportedVersion: "1.3.0"
        },
        "ios"
      )
    ).toBeUndefined();
  });
});

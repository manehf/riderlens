import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { configureAppDelegate } = require('../plugins/withRiderLensTransfer.js');

const template = `import Expo
import React

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  public override func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    return super.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
}
`;

describe('RiderLens background session AppDelegate integration', () => {
  it('routes only the owned session before forwarding other sessions to Expo', () => {
    const result = configureAppDelegate(template);
    expect(result).toContain('import RiderLensTransfer');
    expect(result).toContain('if RiderLensTransferCoordinator.ownsSession(identifier)');
    expect(result).toContain('shared.handleBackgroundEvents(completionHandler: completionHandler)\n      return');
    expect(result).toContain('super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)');
    expect(result.indexOf('ownsSession(identifier)')).toBeLessThan(result.indexOf('super.application(application, handleEventsForBackgroundURLSession:'));
    expect(result).toContain('return super.application(app, open: url, options: options)');
    expect(result.indexOf('ownsSession(identifier)')).toBeLessThan(result.indexOf('class ReactNativeDelegate'));
  });

  it('is idempotent across clean/repeated config evaluation', () => {
    const first = configureAppDelegate(template);
    expect(configureAppDelegate(first)).toBe(first);
    expect(first.match(/import RiderLensTransfer/g)).toHaveLength(1);
  });

  it('rejects another background handler instead of silently stealing SDK callbacks', () => {
    expect(() => configureAppDelegate(template.replace('  public override', '  // handleEventsForBackgroundURLSession\n  public override'))).toThrow(/already owns/);
  });

  it('rejects template drift and incomplete generated blocks', () => {
    expect(() => configureAppDelegate(template.replace('ExpoAppDelegate {', 'OtherDelegate {'))).toThrow(/template/);
    expect(() => configureAppDelegate(`${template}\n  // @generated begin riderlens-transfer`)).toThrow(/incomplete/);
  });
});

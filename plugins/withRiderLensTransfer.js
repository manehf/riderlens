const { withAppDelegate } = require('expo/config-plugins');

const BEGIN = '  // @generated begin riderlens-transfer';
const END = '  // @generated end riderlens-transfer';

/** Only our session bypasses Expo's subscriber fan-out. FileSystem and other
 * sessions keep the original Expo handler and its completion ownership. */
function configureAppDelegate(source) {
  const hasBegin = source.includes(BEGIN);
  const hasEnd = source.includes(END);
  if (hasBegin !== hasEnd) throw new Error('RiderLensTransfer: incomplete generated AppDelegate block.');
  if (hasBegin) {
    source = source.slice(0, source.indexOf(BEGIN)) + source.slice(source.indexOf(END) + END.length).replace(/^\n/, '');
  }
  if (source.includes('handleEventsForBackgroundURLSession')) {
    throw new Error('RiderLensTransfer: AppDelegate already owns background URL sessions. Merge ownership explicitly before prebuild.');
  }
  const declaration = /^public class AppDelegate: ExpoAppDelegate \{\s*$/m;
  const match = source.match(declaration);
  if (!match) throw new Error('RiderLensTransfer: expected Expo Swift AppDelegate template was not found.');
  if (!/^import RiderLensTransfer\s*$/m.test(source)) {
    if (!/^import Expo\s*$/m.test(source)) throw new Error('RiderLensTransfer: expected Expo import was not found.');
    source = source.replace(/^import Expo\s*$/m, 'import Expo\nimport RiderLensTransfer');
  }
  const block = `${BEGIN}
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if RiderLensTransferCoordinator.ownsSession(identifier) {
      RiderLensTransferCoordinator.shared.handleBackgroundEvents(completionHandler: completionHandler)
      return
    }
    super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)
  }
${END}
`;
  return source.replace(declaration, `public class AppDelegate: ExpoAppDelegate {\n${block}`);
}

function withRiderLensTransfer(config) {
  return withAppDelegate(config, (result) => {
    if (result.modResults.language !== 'swift') throw new Error('RiderLensTransfer requires the Expo Swift AppDelegate template.');
    result.modResults.contents = configureAppDelegate(result.modResults.contents);
    return result;
  });
}

module.exports = withRiderLensTransfer;
module.exports.configureAppDelegate = configureAppDelegate;

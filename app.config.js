const isDevelopment = process.env.APP_VARIANT === "development";

module.exports = ({ config }) => ({
  ...config,
  name: isDevelopment ? "RiderLens Dev" : config.name,
  scheme: isDevelopment ? "riderlens-dev" : config.scheme,
  ios: {
    ...config.ios,
    bundleIdentifier: isDevelopment ? "com.riderlens.app.dev" : config.ios?.bundleIdentifier
  },
  android: {
    ...config.android,
    package: isDevelopment ? "com.riderlens.app.dev" : config.android?.package
  },
  plugins: [
    ...(config.plugins ?? []),
    "./plugins/withRiderLensTransfer",
    [
      "expo-dev-client",
      {
        addGeneratedScheme: isDevelopment
      }
    ]
  ]
});

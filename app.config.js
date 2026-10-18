// E2E builds load test books from a plain-HTTP server on the build machine; release builds keep the platform defaults.
module.exports = ({ config }) => {
  if (process.env.E2E !== '1') return config;
  return {
    ...config,
    ios: {
      ...config.ios,
      infoPlist: { ...config.ios.infoPlist, NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } },
    },
    plugins: [...config.plugins, ['expo-build-properties', { android: { usesCleartextTraffic: true } }]],
  };
};

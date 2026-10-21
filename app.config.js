// E2E builds load test books from a plain-HTTP server on the build machine and search a stand-in book catalog;
// release builds keep the platform defaults (plus local-network HTTP, for the computer link).
module.exports = ({ config }) => {
  if (process.env.E2E !== '1') return config;
  return {
    ...config,
    ios: {
      ...config.ios,
      infoPlist: { ...config.ios.infoPlist, NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } },
    },
    extra: { ...config.extra, catalogMock: true },
  };
};

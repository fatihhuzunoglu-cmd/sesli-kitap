const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// OCR runtime and language data ship as opaque .bin assets that the extractor WebView loads on demand.
config.resolver.assetExts.push('bin');

module.exports = config;

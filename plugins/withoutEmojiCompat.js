// Disables androidx EmojiCompat's startup initializer. It binds to Google Play services' downloadable-fonts provider,
// so Android kills the app whenever Play services restarts or updates; a book reader does not need downloadable emoji.
const { withAndroidManifest } = require('expo/config-plugins');

const INITIALIZER = 'androidx.emoji2.text.EmojiCompatInitializer';

module.exports = function withoutEmojiCompat(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';
    const app = manifest.application[0];
    app.provider = app.provider || [];
    let provider = app.provider.find((p) => p.$['android:name'] === 'androidx.startup.InitializationProvider');
    if (!provider) {
      provider = {
        $: {
          'android:name': 'androidx.startup.InitializationProvider',
          'android:authorities': '${applicationId}.androidx-startup',
          'android:exported': 'false',
          'tools:node': 'merge',
        },
      };
      app.provider.push(provider);
    }
    provider['meta-data'] = (provider['meta-data'] || []).filter((m) => m.$['android:name'] !== INITIALIZER);
    provider['meta-data'].push({ $: { 'android:name': INITIALIZER, 'tools:node': 'remove' } });
    return cfg;
  });
};

import { Asset } from 'expo-asset';

// Metro only bundles assets referenced through require().
/* eslint-disable @typescript-eslint/no-require-imports */
const MODULES = {
  core: require('../../assets/ocr/core.bin'),
  worker: require('../../assets/ocr/worker.bin'),
  tur: require('../../assets/ocr/tur.bin'),
  eng: require('../../assets/ocr/eng.bin'),
} as const;
/* eslint-enable @typescript-eslint/no-require-imports */

export type OcrAssetName = keyof typeof MODULES;
export const OCR_ASSETS = Object.keys(MODULES) as OcrAssetName[];

export async function ocrAssetUri(name: OcrAssetName): Promise<string> {
  const asset = Asset.fromModule(MODULES[name]);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error(`OCR verisi bulunamadı: ${name}`);
  return asset.localUri;
}

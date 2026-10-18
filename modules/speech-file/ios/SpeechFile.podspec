Pod::Spec.new do |s|
  s.name           = 'SpeechFile'
  s.version        = '1.0.0'
  s.summary        = 'Synthesize speech to audio files'
  s.description    = 'Writes AVSpeechSynthesizer output to audio files so it can be played through a regular audio queue.'
  s.author         = 'Fatih Uzunoglu'
  s.homepage       = 'https://github.com/fatihhuzunoglu-cmd/sesli-kitap'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end

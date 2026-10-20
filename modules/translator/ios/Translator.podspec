Pod::Spec.new do |s|
  s.name           = 'Translator'
  s.version        = '1.0.0'
  s.summary        = 'On-device translation'
  s.description    = 'Translates text offline with the Translation framework and identifies languages with NaturalLanguage.'
  s.author         = 'Fatih Uzunoglu'
  s.homepage       = 'https://github.com/fatihhuzunoglu-cmd/sesli-kitap'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.frameworks = 'NaturalLanguage', 'SwiftUI'
  s.weak_frameworks = 'Translation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end

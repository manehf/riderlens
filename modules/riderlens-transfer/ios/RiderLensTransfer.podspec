Pod::Spec.new do |s|
  s.name = 'RiderLensTransfer'
  s.version = '1.0.0'
  s.summary = 'Durable RiderLens iOS analysis transfers'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'RiderLens'
  s.homepage = 'https://riderlens.com'
  s.source = { :git => 'https://riderlens.com' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end

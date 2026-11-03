#!/bin/bash
# Checks the iPhone app as far as this Mac allows.
# Works with only the Command Line Tools (no Xcode). Extra steps run automatically when Xcode is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
IOS="$PWD"
# Use the real Xcode when it is installed (never runs xcode-select or sudo).
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
KIT="$IOS/JarvisKit"
APP="$IOS/JarvisPhone"
PROJ="$IOS/JarvisPhone.xcodeproj"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MAC_TARGET=(-target "$(uname -m)-apple-macosx14.0")
step() { echo; echo "== $*"; }

step "1. JarvisKit: typecheck for macOS (Swift 6 language mode) and package manifest"
swiftc -typecheck -swift-version 6 "${MAC_TARGET[@]}" -parse-as-library "$KIT"/Sources/JarvisKit/*.swift
swift build --package-path "$KIT" --scratch-path "$TMP/spm" 2>&1 | tail -3

step "2. JarvisKit: framework-free check executable (stubbed URLProtocol, parsers, pairing, keychain)"
swiftc -swift-version 6 "${MAC_TARGET[@]}" -o "$TMP/checks" \
  "$KIT"/Sources/JarvisKit/*.swift "$KIT/Tests/JarvisKitTests/StubURLProtocol.swift" "$KIT/Checks/main.swift"
"$TMP/checks"

step "3. App sources: typecheck for macOS (iOS-only code is behind #if os(iOS))"
mkdir -p "$TMP/mod"
swiftc -swift-version 6 "${MAC_TARGET[@]}" -parse-as-library -emit-module -module-name JarvisKit \
  -emit-module-path "$TMP/mod/JarvisKit.swiftmodule" -emit-library -o "$TMP/mod/libJarvisKit.dylib" \
  "$KIT"/Sources/JarvisKit/*.swift
# Same as the Xcode project (Swift 5 mode, complete concurrency checking) and also stricter Swift 6 mode.
swiftc -typecheck -swift-version 5 -strict-concurrency=complete "${MAC_TARGET[@]}" -parse-as-library -I "$TMP/mod" "$APP"/*.swift
swiftc -typecheck -swift-version 6 "${MAC_TARGET[@]}" -parse-as-library -I "$TMP/mod" "$APP"/*.swift

step "4. Xcode project files"
plutil -lint "$PROJ/project.pbxproj" "$APP/Info.plist"
xmllint --noout "$PROJ"/xcshareddata/xcschemes/*.xcscheme && echo "scheme: well-formed XML"
for s in 'objectVersion = 77' 'PRODUCT_BUNDLE_IDENTIFIER = se.lamo.jarvis.phone' 'IPHONEOS_DEPLOYMENT_TARGET = 17.0' \
         'CODE_SIGN_STYLE = Automatic' 'DEVELOPMENT_TEAM = ""' 'PBXFileSystemSynchronizedRootGroup' 'XCLocalSwiftPackageReference'; do
  grep -q "$s" "$PROJ/project.pbxproj" || { echo "project.pbxproj is missing: $s"; exit 1; }
done
for k in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription NSCameraUsageDescription; do
  plutil -extract "$k" raw "$APP/Info.plist" >/dev/null || { echo "Info.plist is missing $k"; exit 1; }
done
if plutil -p "$APP/Info.plist" | grep -q NSAppTransportSecurity; then echo "Info.plist must not have ATS exceptions"; exit 1; fi
echo "project settings and Info.plist keys present, no ATS exceptions"
# A locked phone must never reach Jarvis: Siri asks for Face ID or the passcode, and the token is unreadable while locked.
grep -q 'static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication' "$APP/AskJarvisIntent.swift" \
  || { echo "AskJarvisIntent must set authenticationPolicy = .requiresAuthentication"; exit 1; }
grep -q 'kSecAttrAccessibleWhenUnlockedThisDeviceOnly' "$KIT/Sources/JarvisKit/PairingStore.swift" \
  && ! grep -q 'kSecAttrAccessibleAfterFirstUnlock\|kSecAttrAccessibleAlways' "$KIT/Sources/JarvisKit/PairingStore.swift" \
  || { echo "The pairing must be stored WhenUnlockedThisDeviceOnly"; exit 1; }
echo "Siri needs an unlocked phone; the pairing is readable only while unlocked"

step "5. swift-testing tests and iOS build"
if xcodebuild -version >/dev/null 2>&1; then
  echo "Using Xcode at ${DEVELOPER_DIR:-$(xcode-select -p)}"
  swift test --package-path "$KIT" --scratch-path "$TMP/spm-test"
  # With an iOS Simulator runtime: build and run the scheme's tests on an iPhone. Without one: build only.
  SIM=""
  if xcrun simctl list runtimes 2>/dev/null | grep -q "iOS"; then
    SIM="$(xcrun simctl list devices available 2>/dev/null | grep -m1 -oE 'iPhone [^(]*[^ (]' || true)"
  fi
  if [[ -n "$SIM" ]]; then
    echo "Simulator: $SIM"
    xcodebuild -project "$PROJ" -scheme JarvisPhone -destination "platform=iOS Simulator,name=$SIM" \
      -derivedDataPath "$TMP/dd" CODE_SIGNING_ALLOWED=NO build test
  else
    echo "No iOS Simulator runtime installed: building only (tests not run on a simulator)."
    xcodebuild -project "$PROJ" -scheme JarvisPhone -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$TMP/dd" CODE_SIGNING_ALLOWED=NO build
  fi
else
  echo "xcodebuild is not available (Xcode is not installed): iOS build SKIPPED."
  CLT=/Library/Developer/CommandLineTools/Library/Developer
  if [[ -d "$CLT/Frameworks/Testing.framework" && -f "$CLT/usr/lib/lib_TestingInterop.dylib" ]]; then
    echo "Running the swift-testing tests with the Testing framework from the Command Line Tools."
    swift test --package-path "$KIT" --scratch-path "$TMP/spm-test" \
      -Xswiftc -F"$CLT/Frameworks" -Xlinker -F"$CLT/Frameworks" \
      -Xlinker -rpath -Xlinker "$CLT/Frameworks" -Xlinker -rpath -Xlinker "$CLT/usr/lib" 2>&1 \
      | grep -E "^(✔ Test run|✘|error)|Test run with" || { echo "swift-testing run failed"; exit 1; }
    [[ "${PIPESTATUS[0]}" == 0 ]] || { echo "swift-testing run failed"; exit 1; }
  else
    echo "No test framework available: swift test SKIPPED (the check executable in step 2 covers the same ground)."
  fi
fi

echo
echo "ALL CHECKS PASSED"

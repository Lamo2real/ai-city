import Foundation
import Security
import Testing
@testable import JarvisKit

let goodToken = String(repeating: "aB3-_", count: 9) // 45 chars, base64url alphabet
let goodHost = "mac.tail1234.ts.net"

@Suite struct PairingTests {
    @Test func parsesValidPayload() throws {
        let p = try Pairing.parse("jarvis-pair://v1?host=\(goodHost)&token=\(goodToken)")
        #expect(p.host == goodHost)
        #expect(p.token == goodToken)
        #expect(p.baseURL.absoluteString == "https://\(goodHost)")
    }

    @Test func trimsWhitespaceAndLowercasesHost() throws {
        let p = try Pairing.parse("  jarvis-pair://v1?host=MAC.Tail1234.TS.NET&token=\(goodToken)\n")
        #expect(p.host == goodHost)
    }

    @Test(arguments: [
        ("http://v1?host=mac.tail1234.ts.net", PairingError.wrongScheme),
        ("jarvis-pair://v2?host=mac.tail1234.ts.net&token=TOKEN", .unsupportedVersion),
        ("jarvis-pair://v1/extra?host=mac.tail1234.ts.net&token=TOKEN", .malformed),
        ("jarvis-pair://user:pw@v1?host=mac.tail1234.ts.net&token=TOKEN", .malformed),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net&token=TOKEN#frag", .malformed),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net&host=evil.ts.net&token=TOKEN", .malformed),
        ("jarvis-pair://v1?host=evil.example.com&token=TOKEN", .invalidHost),
        ("jarvis-pair://v1?host=ts.net&token=TOKEN", .invalidHost),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net.evil.com&token=TOKEN", .invalidHost),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net:8443&token=TOKEN", .invalidHost),
        ("jarvis-pair://v1?token=TOKEN", .invalidHost),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net", .invalidToken),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net&token=short", .invalidToken),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net&token=\(String(repeating: "a", count: 42))", .invalidToken),
        ("jarvis-pair://v1?host=mac.tail1234.ts.net&token=\(String(repeating: "a", count: 42))=", .invalidToken),
        ("", .malformed),
    ])
    func rejectsBadPayload(payload: String, expected: PairingError) {
        let withToken = payload.replacingOccurrences(of: "TOKEN", with: goodToken)
        #expect(throws: expected) { try Pairing.parse(withToken) }
    }

    @Test func descriptionNeverShowsToken() throws {
        let p = try Pairing(host: goodHost, token: goodToken)
        #expect(!"\(p)".contains(goodToken))
        #expect(!String(reflecting: p).contains(goodToken))
    }

    @Test func decodingValidates() {
        let bad = Data(#"{"host":"evil.com","token":"x"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Pairing.self, from: bad) }
    }
}

@Suite struct PairingStoreTests {
    @Test func inMemoryRoundTrip() throws {
        let store: PairingStore = InMemoryPairingStore()
        #expect(try store.load() == nil)
        let p = try Pairing(host: goodHost, token: goodToken)
        try store.save(p)
        #expect(try store.load() == p)
        try store.clear()
        #expect(try store.load() == nil)
    }
}

@Suite struct KeychainPolicyTests {
    /// The pairing token must not be readable while the phone is locked, and must never leave the device.
    @Test func pairingIsOnlyReadableWhenUnlocked() {
        #expect(KeychainPairingStore.accessibility == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String))
    }
}

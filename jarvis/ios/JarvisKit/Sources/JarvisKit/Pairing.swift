import Foundation

public enum PairingError: Error, Equatable, Sendable, LocalizedError {
    case malformed
    case wrongScheme
    case unsupportedVersion
    case invalidHost
    case invalidToken

    public var message: String {
        switch self {
        case .malformed: return "That isn't a Jarvis pairing code. Run pair-iphone.sh on your Mac and try again."
        case .wrongScheme: return "That isn't a Jarvis pairing code."
        case .unsupportedVersion: return "This pairing code is from a different version. Update the app and the Mac side."
        case .invalidHost: return "The pairing code points to an address that isn't a Tailscale name (.ts.net)."
        case .invalidToken: return "The pairing code has a broken token. Make a new one on your Mac."
        }
    }
    public var errorDescription: String? { message }
}

/// Where the phone talks to and the secret it uses. The token is never printed.
public struct Pairing: Equatable, Sendable, Codable, CustomStringConvertible, CustomDebugStringConvertible {
    public let host: String
    public let token: String

    public static let minimumTokenLength = 43
    public static let maximumTokenLength = 256

    public init(host: String, token: String) throws {
        let h = host.lowercased()
        guard Pairing.isValidHost(h) else { throw PairingError.invalidHost }
        guard Pairing.isValidToken(token) else { throw PairingError.invalidToken }
        self.host = h
        self.token = token
    }

    public var baseURL: URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        return c.url!
    }

    public var description: String { "Pairing(host: \(host), token: <redacted>)" }
    public var debugDescription: String { description }

    // MARK: Codable (decoding goes through validation)
    private enum CodingKeys: String, CodingKey { case host, token }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let h = try c.decode(String.self, forKey: .host)
        let t = try c.decode(String.self, forKey: .token)
        do { try self.init(host: h, token: t) } catch {
            throw DecodingError.dataCorruptedError(forKey: .host, in: c, debugDescription: "invalid pairing")
        }
    }

    // MARK: Parsing

    /// Parses `jarvis-pair://v1?host=<host>&token=<token>`.
    public static func parse(_ payload: String) throws -> Pairing {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count < 1024,
              let c = URLComponents(string: trimmed) else { throw PairingError.malformed }
        guard c.scheme?.lowercased() == "jarvis-pair" else { throw PairingError.wrongScheme }
        guard c.host?.lowercased() == "v1" else { throw PairingError.unsupportedVersion }
        guard c.user == nil, c.password == nil, c.port == nil, c.fragment == nil, c.path.isEmpty else {
            throw PairingError.malformed
        }
        var values: [String: String] = [:]
        for item in c.queryItems ?? [] {
            guard values[item.name] == nil else { throw PairingError.malformed }
            values[item.name] = item.value ?? ""
        }
        guard let host = values["host"] else { throw PairingError.invalidHost }
        guard let token = values["token"] else { throw PairingError.invalidToken }
        return try Pairing(host: host, token: token)
    }

    static func isValidHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.count <= 253 else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 3, labels.suffix(2).elementsEqual(["ts", "net"]) else { return false }
        for label in labels {
            guard (1...63).contains(label.utf8.count),
                  label.first != "-", label.last != "-",
                  label.utf8.allSatisfy({ ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 })
            else { return false }
        }
        return true
    }

    static func isValidToken(_ token: String) -> Bool {
        guard (minimumTokenLength...maximumTokenLength).contains(token.utf8.count) else { return false }
        return token.utf8.allSatisfy {
            ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 || $0 == 95
        }
    }
}

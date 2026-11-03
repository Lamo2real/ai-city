import Foundation
import Security

public protocol PairingStore: Sendable {
    func load() throws -> Pairing?
    func save(_ pairing: Pairing) throws
    func clear() throws
}

public enum PairingStoreError: Error, Equatable, Sendable, LocalizedError {
    case keychain(Int32)
    public var errorDescription: String? {
        switch self {
        case .keychain: return "The phone couldn't read or write its secure storage."
        }
    }
}

/// Stores the pairing in the Keychain: generic password, available after first unlock, never leaves this device.
/// Never UserDefaults. Nothing here logs.
public struct KeychainPairingStore: PairingStore {
    public static let defaultService = "se.lamo.jarvis.pairing"
    /// The token is readable only while the phone is unlocked, and never leaves this device (no backup, no iCloud).
    public static let accessibility: String = kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
    private let service: String
    private let account = "bridge"

    public init(service: String = KeychainPairingStore.defaultService) {
        self.service = service
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func load() throws -> Pairing? {
        var q = baseQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw PairingStoreError.keychain(status) }
        // A corrupt or tampered entry counts as "not paired".
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    public func save(_ pairing: Pairing) throws {
        let data = try JSONEncoder().encode(pairing)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: KeychainPairingStore.accessibility,
        ]
        var status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add.merge(update) { $1 }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PairingStoreError.keychain(status) }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingStoreError.keychain(status) }
    }
}

/// In-memory store for tests and previews.
public final class InMemoryPairingStore: PairingStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Pairing?
    public init(_ initial: Pairing? = nil) { value = initial }
    public func load() throws -> Pairing? { lock.lock(); defer { lock.unlock() }; return value }
    public func save(_ pairing: Pairing) throws { lock.lock(); defer { lock.unlock() }; value = pairing }
    public func clear() throws { lock.lock(); defer { lock.unlock() }; value = nil }
}

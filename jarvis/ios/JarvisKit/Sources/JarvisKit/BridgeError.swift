import Foundation

/// Everything that can go wrong talking to the Mac. `message` is written for the owner, not for developers.
public enum BridgeError: Error, Equatable, Sendable, LocalizedError {
    case notPaired
    case rateLimited(retryAfter: TimeInterval?)
    case forbidden
    case macUnreachable
    case timeout
    case server(Int)
    /// The reply stopped before Jarvis finished.
    case incompleteReply
    /// The Mac answered with something this app does not understand.
    case invalidResponse
    /// Refused to talk over plain http.
    case insecureURL

    public static let unreachableMessage =
        "Can't reach your Mac. Check that Tailscale is on, on both devices, and the Mac is awake."

    public var message: String {
        switch self {
        case .notPaired:
            return "This phone isn't paired with your Mac. Scan the pairing code again."
        case .rateLimited(let retryAfter):
            if let s = retryAfter, s >= 1 {
                return "Slow down. Try again in \(Int(s.rounded(.up))) seconds."
            }
            return "Slow down. Try again in a moment."
        case .forbidden:
            return "Not allowed from the phone."
        case .macUnreachable:
            return Self.unreachableMessage
        case .timeout:
            return "Jarvis took too long to answer. Check that your Mac is awake, then try again."
        case .server(let code):
            return "Your Mac had a problem (error \(code)). Try again in a moment."
        case .incompleteReply:
            return "The reply was cut off. Try again."
        case .invalidResponse:
            return "Your Mac sent something this app doesn't understand. Update the app or the Mac side."
        case .insecureURL:
            return "The app only talks to your Mac over a secure (https) connection."
        }
    }

    public var errorDescription: String? { message }

    /// Errors where retrying cannot help until the owner does something.
    public var isFatalForEvents: Bool {
        switch self {
        case .notPaired, .forbidden, .insecureURL: return true
        default: return false
        }
    }

    /// Maps an HTTP status to an error. Returns nil for 2xx.
    public static func fromStatus(_ status: Int, retryAfter: String?) -> BridgeError? {
        switch status {
        case 200..<300: return nil
        case 401: return .notPaired
        case 403: return .forbidden
        case 429: return .rateLimited(retryAfter: retryAfter.flatMap { TimeInterval($0.trimmingCharacters(in: .whitespaces)) })
        default: return .server(status)
        }
    }

    /// Maps a transport error. `timedOutByDeadline` is true when our own total-time watchdog fired.
    public static func fromTransport(_ error: Error, timedOutByDeadline: Bool = false) -> BridgeError {
        if timedOutByDeadline { return .timeout }
        if let e = error as? BridgeError { return e }
        if let u = error as? URLError {
            switch u.code {
            case .timedOut: return .timeout
            case .appTransportSecurityRequiresSecureConnection: return .insecureURL
            default: return .macUnreachable
            }
        }
        return .macUnreachable
    }
}

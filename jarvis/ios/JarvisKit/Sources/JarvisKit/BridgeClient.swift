import Foundation

public struct BridgeTimeouts: Equatable, Sendable {
    /// Connect / first byte for the health check.
    public var health: TimeInterval
    /// Total time allowed for one chat reply.
    public var chat: TimeInterval
    /// Silence allowed on the events stream (the bridge sends keepalive comments).
    public var eventsIdle: TimeInterval
    public init(health: TimeInterval = 10, chat: TimeInterval = 120, eventsIdle: TimeInterval = 90) {
        self.health = health
        self.chat = chat
        self.eventsIdle = eventsIdle
    }
}

public struct HealthStatus: Equatable, Sendable, Decodable {
    public let ok: Bool
    public let name: String?
}

public enum EventsUpdate: Equatable, Sendable {
    case connected
    /// Jarvis said something unprompted.
    case message(String)
    /// The stream dropped; reconnecting after `retryIn` seconds.
    case disconnected(BridgeError, retryIn: TimeInterval)
    /// Gave up for good (not paired / not allowed). The stream ends after this.
    case stopped(BridgeError)
}

/// Talks to the Jarvis bridge on the Mac. HTTPS only; every request carries the bearer token.
public struct BridgeClient: Sendable {
    public static let apiPrefix = "/api/app/v1/"

    private let baseURL: URL
    private let token: String
    private let session: URLSession
    public let timeouts: BridgeTimeouts

    /// `configuration` is injectable so tests can add a URLProtocol stub.
    public init(baseURL: URL, token: String,
                configuration: URLSessionConfiguration = BridgeClient.defaultConfiguration(),
                timeouts: BridgeTimeouts = BridgeTimeouts()) throws {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host?.isEmpty == false else {
            throw BridgeError.insecureURL
        }
        self.baseURL = baseURL
        self.token = token
        self.session = URLSession(configuration: configuration)
        self.timeouts = timeouts
    }

    public init(pairing: Pairing,
                configuration: URLSessionConfiguration = BridgeClient.defaultConfiguration(),
                timeouts: BridgeTimeouts = BridgeTimeouts()) throws {
        try self.init(baseURL: pairing.baseURL, token: pairing.token, configuration: configuration, timeouts: timeouts)
    }

    public static func defaultConfiguration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.waitsForConnectivity = false
        c.httpCookieStorage = nil
        c.urlCache = nil
        return c
    }

    // MARK: Request building

    public func makeRequest(path: String, method: String = "GET", body: Data? = nil,
                            accept: String = "application/json", timeout: TimeInterval) throws -> URLRequest {
        guard let url = URL(string: Self.apiPrefix + path, relativeTo: baseURL)?.absoluteURL,
              url.scheme?.lowercased() == "https" else { throw BridgeError.insecureURL }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue(accept, forHTTPHeaderField: "Accept")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    private static func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw BridgeError.invalidResponse }
        if let e = BridgeError.fromStatus(http.statusCode, retryAfter: http.value(forHTTPHeaderField: "Retry-After")) {
            throw e
        }
    }

    // MARK: Health

    public func health() async throws -> HealthStatus {
        let request = try makeRequest(path: "health", timeout: timeouts.health)
        do {
            let (data, response) = try await session.data(for: request)
            try Self.check(response)
            guard let status = try? JSONDecoder().decode(HealthStatus.self, from: data), status.ok else {
                throw BridgeError.invalidResponse
            }
            return status
        } catch {
            if error is CancellationError { throw error }
            throw BridgeError.fromTransport(error)
        }
    }

    // MARK: Chat

    /// Streams the reply: fillers and sentences as they arrive, then `.done`. Errors are `BridgeError`.
    public func chat(_ message: String) -> AsyncThrowingStream<ChatEvent, Error> {
        let request: URLRequest
        do {
            let body = try JSONEncoder().encode(["message": message])
            request = try makeRequest(path: "chat", method: "POST", body: body,
                                      accept: "application/x-ndjson", timeout: timeouts.chat)
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: BridgeError.fromTransport(error)) }
        }
        let session = self.session
        let limit = timeouts.chat

        return AsyncThrowingStream { continuation in
            let deadline = DeadlineFlag()
            let work = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    try Self.check(response)
                    var splitter = LineSplitter()
                    var finished = false

                    func handle(_ line: String) throws {
                        guard !finished, let event = try NDJSON.parseChatLine(line) else { return }
                        continuation.yield(event)
                        if case .done = event { finished = true }
                    }
                    for try await byte in bytes {
                        if let line = splitter.push(byte) { try handle(line) }
                        if finished { break }
                    }
                    if let rest = splitter.flush() { try handle(rest) }
                    if finished {
                        continuation.finish()
                    } else {
                        throw BridgeError.incompleteReply
                    }
                } catch {
                    if deadline.fired {
                        continuation.finish(throwing: BridgeError.timeout)
                    } else if error is CancellationError || (error as? URLError)?.code == .cancelled {
                        continuation.finish()
                    } else {
                        continuation.finish(throwing: BridgeError.fromTransport(error))
                    }
                }
            }
            let watchdog = Task {
                try? await Task.sleep(nanoseconds: UInt64(max(limit, 0.01) * 1_000_000_000))
                if !Task.isCancelled { deadline.fire(); work.cancel() }
            }
            continuation.onTermination = { _ in
                work.cancel()
                watchdog.cancel()
            }
        }
    }

    /// Convenience: waits for the whole reply (what the Siri intent wants).
    public func ask(_ message: String) async throws -> String {
        var sentences: [String] = []
        for try await event in chat(message) {
            switch event {
            case .done(let reply):
                return reply.isEmpty ? sentences.joined(separator: " ") : reply
            case .sentence(let s): sentences.append(s)
            case .filler: break
            }
        }
        throw BridgeError.incompleteReply
    }

    // MARK: Events

    /// Jarvis speaking unprompted. Reconnects with backoff until the consumer cancels or the pairing stops working.
    public func events(backoff initialBackoff: Backoff = Backoff()) -> AsyncStream<EventsUpdate> {
        let session = self.session
        let request: URLRequest
        do {
            request = try makeRequest(path: "events", accept: "text/event-stream", timeout: timeouts.eventsIdle)
        } catch {
            let e = BridgeError.fromTransport(error)
            return AsyncStream { $0.yield(.stopped(e)); $0.finish() }
        }

        return AsyncStream { continuation in
            let work = Task {
                var backoff = initialBackoff
                while !Task.isCancelled {
                    var failure = BridgeError.macUnreachable
                    do {
                        let (bytes, response) = try await session.bytes(for: request)
                        try Self.check(response)
                        continuation.yield(.connected)
                        backoff.reset()
                        var splitter = LineSplitter()
                        var parser = SSEParser()
                        for try await byte in bytes {
                            guard let line = splitter.push(byte), let event = parser.feed(line: line) else { continue }
                            if let text = JarvisEventDecoder.text(from: event) { continuation.yield(.message(text)) }
                        }
                        if let event = parser.finish(), let text = JarvisEventDecoder.text(from: event) {
                            continuation.yield(.message(text))
                        }
                    } catch {
                        if error is CancellationError || (error as? URLError)?.code == .cancelled { break }
                        failure = BridgeError.fromTransport(error)
                    }
                    if Task.isCancelled { break }
                    if failure.isFatalForEvents {
                        continuation.yield(.stopped(failure))
                        break
                    }
                    var delay = backoff.next()
                    if case .rateLimited(let after?) = failure { delay = max(delay, after) }
                    continuation.yield(.disconnected(failure, retryIn: delay))
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in work.cancel() }
        }
    }
}

/// Set once by the total-time watchdog so the chat task can tell "timed out" from "cancelled".
final class DeadlineFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var fired: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func fire() { lock.lock(); value = true; lock.unlock() }
}

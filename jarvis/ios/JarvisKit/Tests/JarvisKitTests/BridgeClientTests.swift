import Foundation
import Testing
@testable import JarvisKit

private func client(_ host: String, timeouts: BridgeTimeouts = BridgeTimeouts(),
                    _ handler: @escaping StubURLProtocol.Handler) throws -> BridgeClient {
    StubURLProtocol.register(host: host, handler)
    return try BridgeClient(baseURL: URL(string: "https://\(host)")!, token: goodToken,
                            configuration: StubURLProtocol.configuration(), timeouts: timeouts)
}

private func collect(_ stream: AsyncThrowingStream<ChatEvent, Error>) async throws -> [ChatEvent] {
    var out: [ChatEvent] = []
    for try await e in stream { out.append(e) }
    return out
}

@Suite struct BridgeClientTests {
    @Test func rejectsHttp() {
        #expect(throws: BridgeError.insecureURL) {
            try BridgeClient(baseURL: URL(string: "http://mac.tail1234.ts.net")!, token: goodToken)
        }
    }

    @Test func requestHasAuthHeaderJSONBodyAndHTTPS() throws {
        let c = try BridgeClient(baseURL: URL(string: "https://mac.tail1234.ts.net")!, token: goodToken)
        let body = try JSONEncoder().encode(["message": "hi"])
        let r = try c.makeRequest(path: "chat", method: "POST", body: body, accept: "application/x-ndjson", timeout: 120)
        #expect(r.url?.absoluteString == "https://mac.tail1234.ts.net/api/app/v1/chat")
        #expect(r.httpMethod == "POST")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer \(goodToken)")
        #expect(r.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(r.timeoutInterval == 120)
    }

    @Test func healthOK() async throws {
        let c = try client("health-ok.ts.net") { req, _ in
            #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer \(goodToken)")
            return .init(body: #"{"ok":true,"name":"Jarvis"}"#)
        }
        let h = try await c.health()
        #expect(h.ok && h.name == "Jarvis")
    }

    @Test func healthUsesTenSecondTimeout() async throws {
        let seen = Box<TimeInterval>()
        let c = try client("health-timeout.ts.net") { req, _ in
            seen.value = req.timeoutInterval
            return .init(body: #"{"ok":true,"name":"Jarvis"}"#)
        }
        _ = try await c.health()
        #expect(seen.value == 10)
    }

    @Test(arguments: [
        (401, nil, BridgeError.notPaired),
        (403, nil, .forbidden),
        (429, "7", .rateLimited(retryAfter: 7)),
        (429, nil, .rateLimited(retryAfter: nil)),
        (500, nil, .server(500)),
        (503, nil, .server(503)),
    ] as [(Int, String?, BridgeError)])
    func statusMapping(status: Int, retryAfter: String?, expected: BridgeError) async throws {
        let host = "status-\(status)-\(retryAfter ?? "none").ts.net"
        let c = try client(host) { _, _ in
            .init(status: status, headers: retryAfter.map { ["Retry-After": $0] } ?? [:], body: #"{"error":"x"}"#)
        }
        await #expect(throws: expected) { _ = try await c.health() }
        await #expect(throws: expected) { _ = try await collect(c.chat("hi")) }
    }

    @Test(arguments: [
        (URLError.Code.notConnectedToInternet, BridgeError.macUnreachable),
        (.cannotConnectToHost, .macUnreachable),
        (.cannotFindHost, .macUnreachable),
        (.networkConnectionLost, .macUnreachable),
        (.timedOut, .timeout),
    ])
    func transportMapping(code: URLError.Code, expected: BridgeError) async throws {
        let c = try client("transport-\(code.rawValue).ts.net") { _, _ in .init(error: URLError(code)) }
        await #expect(throws: expected) { _ = try await c.health() }
    }

    @Test func chatStreamsEventsAndSendsMessage() async throws {
        let sentBody = Box<Data>()
        let c = try client("chat-ok.ts.net") { req, body in
            sentBody.value = body
            #expect(req.value(forHTTPHeaderField: "Accept") == "application/x-ndjson")
            return .init(body: """
            {"type":"filler","text":"One moment."}
            {"type":"sentence","text":"It is sunny."}

            {"type":"sentence","text":"Take a hat."}
            {"type":"done","reply":"It is sunny. Take a hat."}

            """)
        }
        let events = try await collect(c.chat("weather?"))
        #expect(events == [.filler("One moment."), .sentence("It is sunny."), .sentence("Take a hat."),
                           .done(reply: "It is sunny. Take a hat.")])
        let decoded = try JSONDecoder().decode([String: String].self, from: try #require(sentBody.value))
        #expect(decoded == ["message": "weather?"])
    }

    @Test func askReturnsFullReply() async throws {
        let c = try client("ask-ok.ts.net") { _, _ in
            .init(body: "{\"type\":\"sentence\",\"text\":\"A.\"}\n{\"type\":\"done\",\"reply\":\"A. B.\"}\n")
        }
        #expect(try await c.ask("x") == "A. B.")
    }

    @Test func cutOffReplyIsReported() async throws {
        let c = try client("chat-cut.ts.net") { _, _ in .init(body: "{\"type\":\"sentence\",\"text\":\"A.\"}\n") }
        await #expect(throws: BridgeError.incompleteReply) { _ = try await collect(c.chat("x")) }
    }

    @Test func garbageLineIsInvalidResponse() async throws {
        let c = try client("chat-garbage.ts.net") { _, _ in .init(body: "<html>oops</html>\n") }
        await #expect(throws: BridgeError.invalidResponse) { _ = try await collect(c.chat("x")) }
    }

    @Test func totalChatDeadlineGivesTimeout() async throws {
        let c = try client("chat-slow.ts.net", timeouts: BridgeTimeouts(chat: 0.2)) { _, _ in
            .init(body: "{\"type\":\"done\",\"reply\":\"late\"}\n", delay: 5)
        }
        await #expect(throws: BridgeError.timeout) { _ = try await collect(c.chat("x")) }
    }

    @Test func eventsDeliverMessagesAndSkipKeepalives() async throws {
        let c = try client("events-ok.ts.net") { _, _ in
            .init(headers: ["Content-Type": "text/event-stream"],
                  body: ": keepalive\n\ndata: {\"type\":\"jarvis\",\"text\":\"Build finished.\"}\n\n")
        }
        var got: [EventsUpdate] = []
        for await u in c.events(backoff: Backoff(initial: 30, maximum: 30)) {
            got.append(u)
            if case .message = u { break }
        }
        #expect(got == [.connected, .message("Build finished.")])
    }

    @Test func eventsStopWhenNotPaired() async throws {
        let c = try client("events-401.ts.net") { _, _ in .init(status: 401) }
        var got: [EventsUpdate] = []
        for await u in c.events() { got.append(u) }
        #expect(got == [.stopped(.notPaired)])
    }

    @Test func eventsReconnectWithBackoff() async throws {
        let c = try client("events-down.ts.net") { _, _ in .init(error: URLError(.cannotConnectToHost)) }
        var got: [EventsUpdate] = []
        for await u in c.events(backoff: Backoff(initial: 0.01, maximum: 0.02)) {
            got.append(u)
            if got.count == 3 { break }
        }
        #expect(got == [.disconnected(.macUnreachable, retryIn: 0.01),
                        .disconnected(.macUnreachable, retryIn: 0.02),
                        .disconnected(.macUnreachable, retryIn: 0.02)])
    }

    @Test func errorMessagesArePlain() {
        #expect(BridgeError.macUnreachable.message == "Can't reach your Mac. Check that Tailscale is on, on both devices, and the Mac is awake.")
        #expect(BridgeError.forbidden.message == "Not allowed from the phone.")
        #expect(BridgeError.rateLimited(retryAfter: 7).message.hasPrefix("Slow down"))
    }
}

final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T?
    var value: T? {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
    }
}

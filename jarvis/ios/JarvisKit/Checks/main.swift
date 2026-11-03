// Framework-free checks for JarvisKit. Compiled together with the JarvisKit sources and Tests/JarvisKitTests/StubURLProtocol.swift
// by scripts/check.sh, so they run with only the Command Line Tools (no XCTest, no swift-testing).
// They mirror Tests/JarvisKitTests. Exit code is non-zero if anything fails.
import Foundation

nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var passed = 0

func check(_ condition: @autoclosure () throws -> Bool, _ name: String, line: Int = #line) rethrows {
    if try condition() { passed += 1 } else { failures += 1; print("FAIL (line \(line)): \(name)") }
}

func checkThrows<E: Error & Equatable>(_ expected: E, _ name: String, line: Int = #line, _ body: () async throws -> Void) async {
    do { try await body(); failures += 1; print("FAIL (line \(line)): \(name): did not throw") }
    catch let e as E where e == expected { passed += 1 }
    catch { failures += 1; print("FAIL (line \(line)): \(name): threw \(error)") }
}

let token = String(repeating: "aB3-_", count: 9)
let host = "mac.tail1234.ts.net"

func makeClient(_ h: String, timeouts: BridgeTimeouts = BridgeTimeouts(),
                _ handler: @escaping StubURLProtocol.Handler) throws -> BridgeClient {
    StubURLProtocol.register(host: h, handler)
    return try BridgeClient(baseURL: URL(string: "https://\(h)")!, token: token,
                            configuration: StubURLProtocol.configuration(), timeouts: timeouts)
}

func collect(_ s: AsyncThrowingStream<ChatEvent, Error>) async throws -> [ChatEvent] {
    var out: [ChatEvent] = []
    for try await e in s { out.append(e) }
    return out
}

// MARK: Pairing
do {
    let p = try Pairing.parse("jarvis-pair://v1?host=\(host)&token=\(token)")
    check(p.host == host && p.token == token, "parse valid")
    check(p.baseURL.absoluteString == "https://\(host)", "base url is https")
    check(!"\(p)".contains(token) && !String(reflecting: p).contains(token), "token redacted in descriptions")
    check((try? Pairing.parse(" jarvis-pair://v1?host=MAC.Tail1234.TS.NET&token=\(token)\n"))?.host == host, "trim + lowercase")
} catch { check(false, "pairing parse threw \(error)") }

let bad: [(String, PairingError)] = [
    ("http://v1?host=\(host)&token=\(token)", .wrongScheme),
    ("jarvis-pair://v2?host=\(host)&token=\(token)", .unsupportedVersion),
    ("jarvis-pair://v1/extra?host=\(host)&token=\(token)", .malformed),
    ("jarvis-pair://user:pw@v1?host=\(host)&token=\(token)", .malformed),
    ("jarvis-pair://v1?host=\(host)&token=\(token)#f", .malformed),
    ("jarvis-pair://v1?host=\(host)&host=x.ts.net&token=\(token)", .malformed),
    ("jarvis-pair://v1?host=evil.example.com&token=\(token)", .invalidHost),
    ("jarvis-pair://v1?host=ts.net&token=\(token)", .invalidHost),
    ("jarvis-pair://v1?host=\(host).evil.com&token=\(token)", .invalidHost),
    ("jarvis-pair://v1?host=\(host):8443&token=\(token)", .invalidHost),
    ("jarvis-pair://v1?token=\(token)", .invalidHost),
    ("jarvis-pair://v1?host=\(host)", .invalidToken),
    ("jarvis-pair://v1?host=\(host)&token=short", .invalidToken),
    ("jarvis-pair://v1?host=\(host)&token=\(String(repeating: "a", count: 42))", .invalidToken),
    ("jarvis-pair://v1?host=\(host)&token=\(String(repeating: "a", count: 43))=", .invalidToken),
    ("", .malformed),
]
for (payload, expected) in bad {
    await checkThrows(expected, "reject \(payload.prefix(50))") { _ = try Pairing.parse(payload) }
}
check((try? JSONDecoder().decode(Pairing.self, from: Data(#"{"host":"evil.com","token":"x"}"#.utf8))) == nil, "decode validates")

// MARK: Store fake
do {
    let store: PairingStore = InMemoryPairingStore()
    let p = try Pairing(host: host, token: token)
    try check(try store.load() == nil, "store starts empty")
    try store.save(p)
    try check(try store.load() == p, "store round trip")
    try store.clear()
    try check(try store.load() == nil, "store clear")
} catch { check(false, "store threw \(error)") }

// MARK: Parsers
do {
    try check(try NDJSON.parseChatLine(#"{"type":"filler","text":"One moment."}"#) == .filler("One moment."), "ndjson filler")
    try check(try NDJSON.parseChatLine(#"{"type":"sentence","text":"Hi."}"#) == .sentence("Hi."), "ndjson sentence")
    try check(try NDJSON.parseChatLine(#"{"type":"done","reply":"Hi."}"#) == .done(reply: "Hi."), "ndjson done")
    try check(try NDJSON.parseChatLine("") == nil, "ndjson blank")
    try check(try NDJSON.parseChatLine(#"{"type":"future"}"#) == nil, "ndjson unknown type ignored")
} catch { check(false, "ndjson threw \(error)") }
await checkThrows(BridgeError.invalidResponse, "ndjson garbage") { _ = try NDJSON.parseChatLine("nope") }

do {
    var s = LineSplitter(); var lines: [String] = []
    for b in Array("a\r\n\nb\nHej åäö\npartial".utf8) { if let l = s.push(b) { lines.append(l) } }
    check(lines == ["a", "", "b", "Hej åäö"] && s.flush() == "partial", "line splitter")

    var p = SSEParser(); var events: [SSEEvent] = []
    for l in [": keepalive", "", #"data: {"type":"jarvis","text":"Done."}"#, "", "event: x", "data: a", "data: b", ""] {
        if let e = p.feed(line: l) { events.append(e) }
    }
    check(events == [SSEEvent(data: #"{"type":"jarvis","text":"Done."}"#), SSEEvent(event: "x", data: "a\nb")], "sse events")
    check(JarvisEventDecoder.text(from: events[0]) == "Done.", "sse jarvis text")
    check(JarvisEventDecoder.text(from: SSEEvent(data: "garbage")) == nil, "sse garbage ignored")
    _ = p.feed(line: "data: tail")
    check(p.finish() == SSEEvent(data: "tail"), "sse flush")

    var b = Backoff(initial: 1, maximum: 8)
    check([b.next(), b.next(), b.next(), b.next(), b.next()] == [1, 2, 4, 8, 8], "backoff")
    b.reset(); check(b.next() == 1, "backoff reset")
}

// MARK: Client (URLProtocol stub)
await checkThrows(BridgeError.insecureURL, "http rejected") {
    _ = try BridgeClient(baseURL: URL(string: "http://\(host)")!, token: token)
}
do {
    let c = try BridgeClient(baseURL: URL(string: "https://\(host)")!, token: token)
    let r = try c.makeRequest(path: "chat", method: "POST", body: Data("{}".utf8), accept: "application/x-ndjson", timeout: 120)
    check(r.url?.absoluteString == "https://\(host)/api/app/v1/chat", "chat url")
    check(r.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)", "auth header")
    check(r.timeoutInterval == 120, "chat timeout")
} catch { check(false, "request building threw \(error)") }

do {
    let c = try makeClient("health-ok.ts.net") { req, _ in
        .init(body: req.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)" && req.timeoutInterval == 10
              ? #"{"ok":true,"name":"Jarvis"}"# : #"{"ok":false}"#)
    }
    let h = try await c.health()
    check(h.ok && h.name == "Jarvis", "health ok with bearer + 10s timeout")
} catch { check(false, "health threw \(error)") }

let statuses: [(Int, String?, BridgeError)] = [
    (401, nil, .notPaired), (403, nil, .forbidden), (429, "7", .rateLimited(retryAfter: 7)),
    (429, nil, .rateLimited(retryAfter: nil)), (500, nil, .server(500)), (503, nil, .server(503)),
]
for (status, retry, expected) in statuses {
    let h = "status-\(status)-\(retry ?? "none").ts.net"
    if let c = try? makeClient(h, { _, _ in .init(status: status, headers: retry.map { ["Retry-After": $0] } ?? [:], body: #"{"error":"x"}"#) }) {
        await checkThrows(expected, "health \(status)") { _ = try await c.health() }
        await checkThrows(expected, "chat \(status)") { _ = try await collect(c.chat("hi")) }
    } else { check(false, "client for \(h)") }
}

let transports: [(URLError.Code, BridgeError)] = [
    (.notConnectedToInternet, .macUnreachable), (.cannotConnectToHost, .macUnreachable),
    (.cannotFindHost, .macUnreachable), (.networkConnectionLost, .macUnreachable), (.timedOut, .timeout),
]
for (code, expected) in transports {
    if let c = try? makeClient("transport-\(code.rawValue).ts.net", { _, _ in .init(error: URLError(code)) }) {
        await checkThrows(expected, "transport \(code.rawValue)") { _ = try await c.health() }
    }
}

do {
    let c = try makeClient("chat-ok.ts.net") { req, body in
        let sent = body.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
        guard sent == ["message": "weather?"], req.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)" else {
            return .init(status: 400)
        }
        return .init(body: """
        {"type":"filler","text":"One moment."}
        {"type":"sentence","text":"It is sunny."}

        {"type":"sentence","text":"Take a hat."}
        {"type":"done","reply":"It is sunny. Take a hat."}

        """)
    }
    let events = try await collect(c.chat("weather?"))
    check(events == [.filler("One moment."), .sentence("It is sunny."), .sentence("Take a hat."),
                     .done(reply: "It is sunny. Take a hat.")], "chat stream via URLProtocol stub")
    let reply = try await c.ask("weather?")
    check(reply == "It is sunny. Take a hat.", "ask returns full reply")
} catch { check(false, "chat stream threw \(error)") }

if let c = try? makeClient("chat-cut.ts.net", { _, _ in .init(body: "{\"type\":\"sentence\",\"text\":\"A.\"}\n") }) {
    await checkThrows(BridgeError.incompleteReply, "cut-off reply") { _ = try await collect(c.chat("x")) }
}
if let c = try? makeClient("chat-garbage.ts.net", { _, _ in .init(body: "<html>oops</html>\n") }) {
    await checkThrows(BridgeError.invalidResponse, "garbage reply") { _ = try await collect(c.chat("x")) }
}
if let c = try? makeClient("chat-slow.ts.net", timeouts: BridgeTimeouts(chat: 0.2), { _, _ in
    .init(body: "{\"type\":\"done\",\"reply\":\"late\"}\n", delay: 5) }) {
    await checkThrows(BridgeError.timeout, "chat total deadline") { _ = try await collect(c.chat("x")) }
}

do {
    let c = try makeClient("events-ok.ts.net") { _, _ in
        .init(body: ": keepalive\n\ndata: {\"type\":\"jarvis\",\"text\":\"Build finished.\"}\n\n")
    }
    var got: [EventsUpdate] = []
    for await u in c.events(backoff: Backoff(initial: 30, maximum: 30)) {
        got.append(u)
        if case .message = u { break }
    }
    check(got == [.connected, .message("Build finished.")], "events stream")

    let c401 = try makeClient("events-401.ts.net") { _, _ in .init(status: 401) }
    var stopped: [EventsUpdate] = []
    for await u in c401.events() { stopped.append(u) }
    check(stopped == [.stopped(.notPaired)], "events stop when not paired")

    let down = try makeClient("events-down.ts.net") { _, _ in .init(error: URLError(.cannotConnectToHost)) }
    var retries: [EventsUpdate] = []
    for await u in down.events(backoff: Backoff(initial: 0.01, maximum: 0.02)) {
        retries.append(u)
        if retries.count == 3 { break }
    }
    check(retries == [.disconnected(.macUnreachable, retryIn: 0.01), .disconnected(.macUnreachable, retryIn: 0.02),
                      .disconnected(.macUnreachable, retryIn: 0.02)], "events reconnect with backoff")
} catch { check(false, "events threw \(error)") }

check(BridgeError.macUnreachable.message == "Can't reach your Mac. Check that Tailscale is on, on both devices, and the Mac is awake.", "unreachable message")
check(BridgeError.forbidden.message == "Not allowed from the phone.", "forbidden message")

// MARK: Keychain (real; skipped if this unsigned macOS tool can't use the keychain)
do {
    let store = KeychainPairingStore(service: "se.lamo.jarvis.pairing.check-\(ProcessInfo.processInfo.processIdentifier)")
    let p = try Pairing(host: host, token: token)
    do {
        try store.save(p)
        try check(try store.load() == p, "keychain round trip")
        try store.save(p)
        try store.clear()
        try check(try store.load() == nil, "keychain clear")
    } catch PairingStoreError.keychain(let status) {
        print("SKIPPED keychain round trip (OSStatus \(status)): not available to this unsigned command-line tool")
        try? store.clear()
    }
} catch { check(false, "keychain threw \(error)") }

print("\(passed) checks passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)

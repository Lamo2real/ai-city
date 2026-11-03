import Foundation

// MARK: - Line splitting

/// Splits a byte stream into lines on \n (a trailing \r is dropped). Unlike `AsyncBytes.lines`, empty lines are kept,
/// which Server-Sent Events need.
public struct LineSplitter: Sendable {
    private var buffer: [UInt8] = []
    public init() {}

    public mutating func push(_ byte: UInt8) -> String? {
        if byte == 0x0A {
            if buffer.last == 0x0D { buffer.removeLast() }
            let line = String(decoding: buffer, as: UTF8.self)
            buffer.removeAll(keepingCapacity: true)
            return line
        }
        buffer.append(byte)
        return nil
    }

    /// Whatever is left when the stream ends without a final newline.
    public mutating func flush() -> String? {
        guard !buffer.isEmpty else { return nil }
        if buffer.last == 0x0D { buffer.removeLast() }
        let line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll()
        return line
    }
}

// MARK: - Chat (NDJSON)

public enum ChatEvent: Equatable, Sendable {
    case filler(String)
    case sentence(String)
    case done(reply: String)
}

public enum NDJSON {
    private struct Raw: Decodable { let type: String; let text: String?; let reply: String? }

    /// One line of the chat stream. Blank lines and unknown event types give nil (forward compatible).
    /// Broken JSON throws `invalidResponse`.
    public static func parseChatLine(_ line: String) throws -> ChatEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: Data(trimmed.utf8)) else {
            throw BridgeError.invalidResponse
        }
        switch raw.type {
        case "filler":
            guard let t = raw.text else { throw BridgeError.invalidResponse }
            return .filler(t)
        case "sentence":
            guard let t = raw.text else { throw BridgeError.invalidResponse }
            return .sentence(t)
        case "done":
            return .done(reply: raw.reply ?? "")
        default:
            return nil
        }
    }
}

// MARK: - Events (SSE)

public struct SSEEvent: Equatable, Sendable {
    public var event: String?
    public var data: String
    public init(event: String? = nil, data: String) { self.event = event; self.data = data }
}

/// Server-Sent Events parser. Feed it lines (including empty ones); it returns an event when one is complete.
public struct SSEParser: Sendable {
    private var dataLines: [String] = []
    private var eventName: String?
    public init() {}

    public mutating func feed(line: String) -> SSEEvent? {
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") { return nil } // keepalive / comment
        let field: Substring
        var value: Substring
        if let i = line.firstIndex(of: ":") {
            field = line[..<i]
            value = line[line.index(after: i)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "data": dataLines.append(String(value))
        case "event": eventName = String(value)
        default: break
        }
        return nil
    }

    /// Call when the stream ends, to flush an event that never got its blank line.
    public mutating func finish() -> SSEEvent? { dispatch() }

    private mutating func dispatch() -> SSEEvent? {
        defer { dataLines.removeAll(); eventName = nil }
        guard !dataLines.isEmpty else { return nil }
        return SSEEvent(event: eventName, data: dataLines.joined(separator: "\n"))
    }
}

public enum JarvisEventDecoder {
    private struct Raw: Decodable { let type: String; let text: String? }

    /// The text Jarvis said unprompted, or nil for anything else.
    public static func text(from event: SSEEvent) -> String? {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: Data(event.data.utf8)),
              raw.type == "jarvis", let t = raw.text,
              !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return t
    }
}

// MARK: - Backoff

/// Reconnect delays: 1, 2, 4, ... capped. Pure and deterministic.
public struct Backoff: Equatable, Sendable {
    public var initial: TimeInterval
    public var maximum: TimeInterval
    private var current: TimeInterval

    public init(initial: TimeInterval = 1, maximum: TimeInterval = 30) {
        self.initial = initial
        self.maximum = maximum
        self.current = initial
    }

    public mutating func next() -> TimeInterval {
        let d = current
        current = min(current * 2, maximum)
        return min(d, maximum)
    }

    public mutating func reset() { current = initial }
}

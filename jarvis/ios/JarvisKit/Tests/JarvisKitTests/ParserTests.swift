import Foundation
import Testing
@testable import JarvisKit

@Suite struct ParserTests {
    @Test func ndjsonLines() throws {
        #expect(try NDJSON.parseChatLine(#"{"type":"filler","text":"One moment."}"#) == .filler("One moment."))
        #expect(try NDJSON.parseChatLine(#"{"type":"sentence","text":"Hello."}"#) == .sentence("Hello."))
        #expect(try NDJSON.parseChatLine(#"{"type":"done","reply":"Hello."}"#) == .done(reply: "Hello."))
        #expect(try NDJSON.parseChatLine("") == nil)
        #expect(try NDJSON.parseChatLine(#"{"type":"future-thing"}"#) == nil)
        #expect(throws: BridgeError.invalidResponse) { try NDJSON.parseChatLine("not json") }
        #expect(throws: BridgeError.invalidResponse) { try NDJSON.parseChatLine(#"{"type":"sentence"}"#) }
    }

    @Test func lineSplitterKeepsEmptyLinesAndDropsCR() {
        var s = LineSplitter()
        var lines: [String] = []
        for b in Array("a\r\n\nb\npartial".utf8) { if let l = s.push(b) { lines.append(l) } }
        #expect(lines == ["a", "", "b"])
        #expect(s.flush() == "partial")
        #expect(s.flush() == nil)
    }

    @Test func lineSplitterHandlesMultibyteUTF8() {
        var s = LineSplitter()
        var lines: [String] = []
        for b in Array("Hej – åäö\n".utf8) { if let l = s.push(b) { lines.append(l) } }
        #expect(lines == ["Hej – åäö"])
    }

    @Test func sseEventsAndKeepalives() {
        var p = SSEParser()
        let lines = [": keepalive", "", #"data: {"type":"jarvis","text":"Done."}"#, "", "event: x", "data: a", "data: b", ""]
        var events: [SSEEvent] = []
        for l in lines { if let e = p.feed(line: l) { events.append(e) } }
        #expect(events == [SSEEvent(data: #"{"type":"jarvis","text":"Done."}"#), SSEEvent(event: "x", data: "a\nb")])
        #expect(p.finish() == nil)
    }

    @Test func sseFlushesUnterminatedEvent() {
        var p = SSEParser()
        #expect(p.feed(line: "data: tail") == nil)
        #expect(p.finish() == SSEEvent(data: "tail"))
    }

    @Test func jarvisEventDecoding() {
        #expect(JarvisEventDecoder.text(from: SSEEvent(data: #"{"type":"jarvis","text":"Hi"}"#)) == "Hi")
        #expect(JarvisEventDecoder.text(from: SSEEvent(data: #"{"type":"other","text":"Hi"}"#)) == nil)
        #expect(JarvisEventDecoder.text(from: SSEEvent(data: #"{"type":"jarvis","text":"  "}"#)) == nil)
        #expect(JarvisEventDecoder.text(from: SSEEvent(data: "garbage")) == nil)
    }

    @Test func backoffDoublesCapsAndResets() {
        var b = Backoff(initial: 1, maximum: 8)
        #expect([b.next(), b.next(), b.next(), b.next(), b.next()] == [1, 2, 4, 8, 8])
        b.reset()
        #expect(b.next() == 1)
    }
}

import Foundation
import JarvisKit
import Observation

struct ChatMessage: Identifiable, Equatable {
    enum Role: Equatable { case owner, jarvis }
    enum State: Equatable { case normal, sending, streaming, failed(String) }

    let id = UUID()
    var role: Role
    var text: String
    /// "One moment." style lead-in, shown until real sentences arrive.
    var filler: String?
    var state: State = .normal
}

enum Connection: Equatable {
    case unknown, online
    case offline(String)
    case notPaired
}

@MainActor
@Observable
final class AppModel {
    private(set) var pairing: Pairing?
    private(set) var messages: [ChatMessage] = []
    private(set) var connection: Connection = .unknown
    private(set) var isBusy = false
    /// Shown on the pairing screen, e.g. after the Mac stopped recognising this phone.
    var pairingNotice: String?

    let speaker = Speaker()
    let recognizer = SpeechRecognizer()

    @ObservationIgnored private let store: PairingStore
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var chatTask: Task<Void, Never>?

    init(store: PairingStore = KeychainPairingStore()) {
        self.store = store
        self.pairing = try? store.load()
        self.connection = pairing == nil ? .notPaired : .unknown
        recognizer.onFinished = { [weak self] text in self?.send(text) }
    }

    // MARK: Pairing

    func pair(payload: String) throws {
        let p = try Pairing.parse(payload)
        try store.save(p)
        pairing = p
        pairingNotice = nil
        connection = .unknown
        refreshHealth()
        startEvents()
    }

    func unpair(notice: String? = nil) {
        stopEvents()
        chatTask?.cancel()
        speaker.stop()
        try? store.clear()
        pairing = nil
        isBusy = false
        connection = .notPaired
        pairingNotice = notice
    }

    private func client() -> BridgeClient? {
        guard let pairing else { return nil }
        return try? BridgeClient(pairing: pairing)
    }

    // MARK: Talking

    func beginTalking() {
        speaker.stop()
        Task { await recognizer.start() }
    }

    func endTalking() { recognizer.release() }

    func send(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !isBusy else { return }
        speaker.stop()
        let message = ChatMessage(role: .owner, text: clean, state: .sending)
        messages.append(message)
        deliver(message.id)
    }

    func retry(_ id: UUID) {
        guard !isBusy, let i = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[i].state = .sending
        deliver(id)
    }

    private func deliver(_ ownerID: UUID) {
        guard let text = messages.first(where: { $0.id == ownerID })?.text else { return }
        guard let client = client() else { fail(ownerID, .notPaired); return }
        isBusy = true
        let reply = ChatMessage(role: .jarvis, text: "", state: .streaming)
        let replyID = reply.id
        messages.append(reply)

        chatTask = Task { [weak self] in
            var heardSentence = false
            do {
                for try await event in client.chat(text) {
                    guard let self else { return }
                    switch event {
                    case .filler(let t):
                        self.update(replyID) { $0.filler = t }
                        if !heardSentence { self.speaker.speak(t) }
                    case .sentence(let t):
                        heardSentence = true
                        self.update(replyID) { $0.text += ($0.text.isEmpty ? "" : " ") + t; $0.filler = nil }
                        self.speaker.speak(t)
                    case .done(let full):
                        self.update(replyID) { $0.text = full.isEmpty ? $0.text : full; $0.filler = nil; $0.state = .normal }
                        if !heardSentence { self.speaker.speak(full) }
                    }
                }
                self?.update(ownerID) { $0.state = .normal }
                self?.connection = .online
            } catch is CancellationError {
            } catch {
                self?.fail(ownerID, (error as? BridgeError) ?? .macUnreachable, replyID: replyID)
            }
            self?.isBusy = false
        }
    }

    private func fail(_ ownerID: UUID, _ error: BridgeError, replyID: UUID? = nil) {
        if let replyID, let i = messages.firstIndex(where: { $0.id == replyID }) {
            // Keep a partly received reply; drop an empty one.
            if messages[i].text.isEmpty { messages.remove(at: i) } else { messages[i].state = .normal }
        }
        update(ownerID) { $0.state = .failed(error.message) }
        isBusy = false
        switch error {
        case .notPaired:
            unpair(notice: "Your Mac no longer recognises this phone. Pair it again.")
        case .macUnreachable, .timeout:
            connection = .offline(error.message)
        default:
            break
        }
    }

    private func update(_ id: UUID, _ change: (inout ChatMessage) -> Void) {
        guard let i = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[i])
    }

    // MARK: Connection

    func refreshHealth() {
        guard let client = client() else { connection = .notPaired; return }
        Task { [weak self] in
            do {
                _ = try await client.health()
                self?.connection = .online
            } catch let error as BridgeError {
                if error == .notPaired {
                    self?.unpair(notice: "Your Mac no longer recognises this phone. Pair it again.")
                } else {
                    self?.connection = .offline(error.message)
                }
            } catch {}
        }
    }

    // MARK: Jarvis speaking unprompted (foreground only)

    func startEvents() {
        guard eventsTask == nil, let client = client() else { return }
        eventsTask = Task { [weak self] in
            for await update in client.events() {
                guard let self else { return }
                switch update {
                case .connected:
                    self.connection = .online
                case .message(let text):
                    self.messages.append(ChatMessage(role: .jarvis, text: text))
                    self.speaker.speak(text)
                case .disconnected(let error, _):
                    self.connection = .offline(error.message)
                case .stopped(let error):
                    if error == .notPaired {
                        self.unpair(notice: "Your Mac no longer recognises this phone. Pair it again.")
                    } else {
                        self.connection = .offline(error.message)
                    }
                }
            }
        }
    }

    func stopEvents() {
        eventsTask?.cancel()
        eventsTask = nil
    }

    func becameActive() {
        refreshHealth()
        startEvents()
    }

    func becameBackground() {
        stopEvents()
        recognizer.cancel()
    }
}

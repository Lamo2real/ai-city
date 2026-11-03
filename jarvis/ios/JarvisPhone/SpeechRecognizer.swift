import AVFoundation
import Observation
import Speech

/// Push-to-talk speech recognition. On-device whenever the phone supports it for the chosen language.
@MainActor
@Observable
final class SpeechRecognizer {
    enum State: Equatable { case idle, starting, listening, finishing }

    static let localeKey = "speechLocale"
    static let locales: [(id: String, name: String)] = [("en-GB", "English"), ("sv-SE", "Svenska")]

    private(set) var state: State = .idle
    /// What has been heard so far, shown while the button is held.
    private(set) var partialText = ""
    var issue: PermissionIssue?
    /// Called once with the final text when the owner lets go.
    @ObservationIgnored var onFinished: ((String) -> Void)?

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var releasedEarly = false
    @ObservationIgnored private var delivered = false

    private var localeID: String { UserDefaults.standard.string(forKey: Self.localeKey) ?? "en-GB" }

    // MARK: Hold / release

    func start() async {
        guard state == .idle else { return }
        state = .starting
        partialText = ""
        issue = nil
        releasedEarly = false
        delivered = false

        guard await requestSpeechAuthorization() == .authorized else { fail(.speech); return }
        guard await requestMicrophonePermission() else { fail(.microphone); return }
        guard !releasedEarly else { state = .idle; return }

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID)), recognizer.isAvailable else {
            fail(.unavailable("Speech recognition isn't available right now for this language. You can still type."))
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }

        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            #endif
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { throw CocoaError(.featureUnsupported) }
            Self.installTap(on: input, format: format, request: request)
            engine.prepare()
            try engine.start()
            self.engine = engine
        } catch {
            fail(.unavailable("The microphone couldn't start. Close other apps that use it and try again. You can still type."))
            return
        }

        self.request = request
        task = Self.startTask(recognizer: recognizer, request: request) { [weak self] text, isFinal, failed in
            Task { @MainActor in self?.handle(text: text, isFinal: isFinal, failed: failed) }
        }
        state = .listening
        if releasedEarly { release() }
    }

    func release() {
        switch state {
        case .starting:
            releasedEarly = true // start() notices after its permission checks
        case .listening:
            state = .finishing
            stopAudio()
            request?.endAudio()
            // If the recogniser never sends a final result, use what we have.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                self?.deliver()
            }
        default:
            break
        }
    }

    func cancel() {
        delivered = true
        teardown()
    }

    // MARK: Internals

    private func fail(_ issue: PermissionIssue) {
        self.issue = issue
        teardown()
    }

    private func handle(text: String, isFinal: Bool, failed: Bool) {
        guard state == .listening || state == .finishing else { return }
        if !text.isEmpty { partialText = text }
        if failed && state == .listening && !isFinal {
            fail(.unavailable("Speech recognition stopped. Try again, or type instead."))
            return
        }
        if isFinal || (failed && state == .finishing) { deliver() }
    }

    private func deliver() {
        guard state == .finishing, !delivered else { return }
        delivered = true
        let text = partialText.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown()
        if !text.isEmpty { onFinished?(text) }
    }

    private func stopAudio() {
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning { engine.stop() }
        }
        engine = nil
        #if os(iOS)
        // Give the audio back: other apps stop being ducked even when the reply is muted.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func teardown() {
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        state = .idle
        partialText = ""
    }

    // These run off the main actor: audio and Speech call back on their own threads.
    private nonisolated static func installTap(on node: AVAudioInputNode, format: AVAudioFormat,
                                               request: SFSpeechAudioBufferRecognitionRequest) {
        nonisolated(unsafe) let request = request
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private nonisolated static func startTask(recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest,
                                              onUpdate: @escaping @Sendable (String, Bool, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            onUpdate(result?.bestTranscription.formattedString ?? "", result?.isFinal ?? false, error != nil)
        }
    }
}

private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
    await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
}

private func requestMicrophonePermission() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return true
    case .denied: return false
    default: return await AVAudioApplication.requestRecordPermission()
    }
}

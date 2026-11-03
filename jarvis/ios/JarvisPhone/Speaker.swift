import AVFoundation
import NaturalLanguage

/// Reads Jarvis's sentences aloud as they stream in. British English, or Swedish when the text is Swedish.
@MainActor
final class Speaker {
    static let mutedKey = "muted"
    private let synthesizer = AVSpeechSynthesizer()

    var isMuted: Bool { UserDefaults.standard.bool(forKey: Self.mutedKey) }

    func speak(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !isMuted else { return }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        #endif
        let utterance = AVSpeechUtterance(string: clean)
        utterance.voice = AVSpeechSynthesisVoice(language: Self.language(for: clean))
        synthesizer.speak(utterance) // the synthesizer queues, so sentences play in order
    }

    /// Stops at once. Called when the owner starts talking or turns mute on.
    func stop() {
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    nonisolated static func language(for text: String) -> String {
        let recognizer = NLLanguageRecognizer()
        recognizer.languageConstraints = [.english, .swedish]
        recognizer.processString(text)
        return recognizer.dominantLanguage == .swedish ? "sv-SE" : "en-GB"
    }
}

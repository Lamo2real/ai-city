import AppIntents
import JarvisKit

/// "Hey Siri, Ask Jarvis". Sends the request to the Mac and has Siri read the reply.
struct AskJarvisIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Jarvis"
    static let description = IntentDescription("Ask Jarvis something and hear the answer.")
    static let openAppWhenRun = false
    /// Jarvis can file tickets (code, money, infrastructure), so a locked phone must not reach it:
    /// Siri asks for Face ID or the passcode first. Never weaker than the passcode-protected LAN route.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Request", requestValueDialog: "What do you want to ask Jarvis?")
    var request: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: IntentDialog(stringLiteral: await Self.answer(for: request)))
    }

    /// Always returns something Siri can say; never throws for expected problems.
    static func answer(for request: String, store: PairingStore = KeychainPairingStore()) async -> String {
        guard let pairing = try? store.load() else {
            return "Jarvis isn't paired yet. Open the Jarvis app and scan the code from your Mac."
        }
        do {
            let client = try BridgeClient(pairing: pairing)
            let reply = try await client.ask(request)
            return reply.isEmpty ? "Jarvis had nothing to say." : reply
        } catch let error as BridgeError {
            return error.message
        } catch {
            return BridgeError.macUnreachable.message
        }
    }
}

struct JarvisShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskJarvisIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) something",
                "Talk to \(.applicationName)",
            ],
            shortTitle: "Ask Jarvis",
            systemImageName: "waveform"
        )
    }
}

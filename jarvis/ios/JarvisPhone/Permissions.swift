import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// A permission the owner said no to. Each one gets a plain explanation and a way to fix it.
enum PermissionIssue: Equatable {
    case microphone, speech, camera, unavailable(String)

    var message: String {
        switch self {
        case .microphone:
            return "Jarvis can't hear you because microphone access is off. You can still type. To talk, turn the microphone on in Settings."
        case .speech:
            return "Jarvis can't turn your voice into text because speech recognition is off. You can still type. To talk, turn it on in Settings."
        case .camera:
            return "The camera is off for Jarvis, so it can't scan the pairing code. Turn it on in Settings, or paste the code instead."
        case .unavailable(let text):
            return text
        }
    }

    var canOpenSettings: Bool {
        if case .unavailable = self { return false }
        return true
    }
}

@MainActor
func openAppSettings() {
    #if canImport(UIKit)
    if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
    }
    #endif
}

struct PermissionBanner: View {
    let issue: PermissionIssue
    var dismiss: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(issue.message).font(.callout)
            HStack {
                if issue.canOpenSettings {
                    Button("Open Settings") { openAppSettings() }.buttonStyle(.borderedProminent)
                }
                if let dismiss { Button("Dismiss", action: dismiss).buttonStyle(.bordered) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.orange.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal)
    }
}

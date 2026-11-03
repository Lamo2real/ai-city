import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Speaker.mutedKey) private var muted = false
    @AppStorage(SpeechRecognizer.localeKey) private var speechLocale = "en-GB"
    @State private var draft = ""
    @State private var holding = false
    @FocusState private var typing: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if case .offline(let text) = model.connection {
                    OfflineBanner(text: text) { model.refreshHealth() }
                }
                messageList
                if let issue = model.recognizer.issue {
                    PermissionBanner(issue: issue) { model.recognizer.issue = nil }
                        .padding(.bottom, 6)
                }
                controls
            }
            .navigationTitle("Jarvis")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) { StatusTitle(connection: model.connection) }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        muted.toggle()
                        if muted { model.speaker.stop() }
                    } label: {
                        Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    }
                    .accessibilityLabel(muted ? "Unmute Jarvis" : "Mute Jarvis")
                    Menu {
                        Picker("I speak", selection: $speechLocale) {
                            ForEach(SpeechRecognizer.locales, id: \.id) { Text($0.name).tag($0.id) }
                        }
                        Button("Pair again", role: .destructive) { model.unpair() }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
    }

    // MARK: Messages

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.messages.isEmpty {
                        Text("Hold the big button and talk, or type below.")
                            .foregroundStyle(.secondary)
                            .padding(.top, 40)
                    }
                    ForEach(model.messages) { message in
                        Bubble(message: message) { model.retry(message.id) }
                            .id(message.id)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.last) { _, last in
                guard let last else { return }
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    // MARK: Controls

    private var controls: some View {
        VStack(spacing: 10) {
            if model.recognizer.state != .idle {
                Text(model.recognizer.partialText.isEmpty ? "Listening…" : model.recognizer.partialText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .padding(.horizontal)
                    .transition(.opacity)
            }
            talkButton
            HStack {
                TextField("Or type to Jarvis", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($typing)
                    .submitLabel(.send)
                    .onSubmit(sendDraft)
                Button(action: sendDraft) { Image(systemName: "arrow.up.circle.fill").font(.title) }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy)
                    .accessibilityLabel("Send")
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var talkButton: some View {
        ZStack {
            Circle()
                .fill(holding ? Color.red : Color.accentColor)
                .frame(width: 96, height: 96)
                .scaleEffect(holding ? 1.12 : 1)
                .shadow(radius: holding ? 12 : 4)
            Image(systemName: "mic.fill").font(.system(size: 36)).foregroundStyle(.white)
        }
        .opacity(model.isBusy ? 0.4 : 1)
        .animation(.easeOut(duration: 0.15), value: holding)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !holding, !model.isBusy else { return }
                    holding = true
                    typing = false
                    model.beginTalking()
                }
                .onEnded { _ in
                    guard holding else { return }
                    holding = false
                    model.endTalking()
                }
        )
        .accessibilityElement()
        .accessibilityLabel("Hold to talk")
        .accessibilityHint("Press and hold, speak, then let go to send")
        .accessibilityAddTraits(.isButton)
    }

    private func sendDraft() {
        let text = draft
        draft = ""
        model.send(text)
    }
}

// MARK: - Pieces

private struct Bubble: View {
    let message: ChatMessage
    let retry: () -> Void

    private var isOwner: Bool { message.role == .owner }

    var body: some View {
        VStack(alignment: isOwner ? .trailing : .leading, spacing: 4) {
            HStack {
                if isOwner { Spacer(minLength: 40) }
                content
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .foregroundStyle(isOwner ? Color.white : Color.primary)
                    .background(isOwner ? Color.accentColor : Color.secondary.opacity(0.18),
                                in: RoundedRectangle(cornerRadius: 18))
                if !isOwner { Spacer(minLength: 40) }
            }
            if case .failed(let reason) = message.state {
                HStack(spacing: 8) {
                    Text(reason).font(.caption).foregroundStyle(.red)
                    Button("Retry", action: retry).font(.caption.bold())
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: isOwner ? .trailing : .leading)
    }

    @ViewBuilder private var content: some View {
        if message.text.isEmpty {
            if message.state == .streaming {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    if let filler = message.filler { Text(filler).italic() }
                }
            } else {
                Text(" ")
            }
        } else {
            Text(message.text).textSelection(.enabled)
        }
    }
}

private struct StatusTitle: View {
    let connection: Connection

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 10, height: 10)
            Text("Jarvis").font(.headline)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(label)
    }

    private var color: Color {
        switch connection {
        case .online: return .green
        case .offline, .notPaired: return .red
        case .unknown: return .gray
        }
    }

    private var label: String {
        switch connection {
        case .online: return "Connected"
        case .offline, .notPaired: return "Not connected"
        case .unknown: return "Checking connection"
        }
    }
}

private struct OfflineBanner: View {
    let text: String
    let retry: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "wifi.exclamationmark")
            Text(text).font(.footnote)
            Spacer(minLength: 8)
            Button("Check again", action: retry).font(.footnote.bold())
        }
        .padding(10)
        .frame(maxWidth: .infinity)
        .background(Color.red.opacity(0.15))
    }
}

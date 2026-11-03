import AVFoundation
import JarvisKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var pasted = ""
    @State private var error: String?
    @State private var scanning = false
    @State private var cameraIssue: PermissionIssue?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Pair with your Mac").font(.title2.bold())
                    if let notice = model.pairingNotice {
                        Text(notice).foregroundStyle(.orange)
                    }
                    Text("On your Mac, run pair-iphone.sh. It shows a QR code. Scan it here, or paste the code it prints.")
                        .foregroundStyle(.secondary)

                    scanner

                    Divider()

                    Text("Or paste the code").font(.headline)
                    TextField("jarvis-pair://v1?host=…", text: $pasted, axis: .vertical)
                        .lineLimit(2...5)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                    HStack {
                        #if canImport(UIKit)
                        Button("Paste") { pasted = UIPasteboard.general.string ?? pasted }
                            .buttonStyle(.bordered)
                        #endif
                        Button("Pair") { attempt(pasted) }
                            .buttonStyle(.borderedProminent)
                            .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    if let error { Text(error).foregroundStyle(.red).font(.callout) }
                }
                .padding()
            }
            .navigationTitle("Jarvis")
        }
    }

    @ViewBuilder private var scanner: some View {
        #if os(iOS)
        if scanning {
            QRScannerView(onCode: { code in
                scanning = false
                attempt(code)
            }, onProblem: { issue in
                scanning = false
                cameraIssue = issue
            })
            .frame(height: 280)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            Button("Stop scanning") { scanning = false }.buttonStyle(.bordered)
        } else {
            Button {
                Task { await startScanning() }
            } label: {
                Label("Scan QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        if let cameraIssue { PermissionBanner(issue: cameraIssue).padding(.horizontal, -16) }
        #else
        Text("QR scanning needs the iPhone camera.").foregroundStyle(.secondary)
        #endif
    }

    private func startScanning() async {
        cameraIssue = nil
        error = nil
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            scanning = true
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: .video) { scanning = true } else { cameraIssue = .camera }
        default:
            cameraIssue = .camera
        }
    }

    private func attempt(_ payload: String) {
        do {
            try model.pair(payload: payload)
            error = nil
            pasted = ""
        } catch let e as PairingError {
            error = e.message
        } catch {
            self.error = "Couldn't save the pairing on this phone. Try again."
        }
    }
}

#if os(iOS)
import AVFoundation
import SwiftUI
import UIKit

/// Camera view that reports the first QR code it sees.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onProblem: (PermissionIssue) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onProblem = onProblem
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

/// Starting and stopping an AVCaptureSession blocks, so it runs on its own queue.
private final class SessionRunner: @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "se.lamo.jarvis.camera")
    func start() { queue.async { if !self.session.isRunning { self.session.startRunning() } } }
    func stop() { queue.async { if self.session.isRunning { self.session.stopRunning() } } }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onProblem: ((PermissionIssue) -> Void)?
    private let runner = SessionRunner()
    private var preview: AVCaptureVideoPreviewLayer?
    private var reported = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              runner.session.canAddInput(input) else {
            onProblem?(.unavailable("No camera is available here. Paste the pairing code instead."))
            return
        }
        runner.session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard runner.session.canAddOutput(output) else {
            onProblem?(.unavailable("The camera couldn't start. Paste the pairing code instead."))
            return
        }
        runner.session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: runner.session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        runner.start()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        runner.stop()
    }

    // Delivered on the main queue (set above).
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
        MainActor.assumeIsolated {
            guard !reported, let code, code.hasPrefix("jarvis-pair://") else { return }
            reported = true
            onCode?(code)
        }
    }
}
#endif

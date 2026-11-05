// The Jarvis Mac app: one native window on the HUD the local server already serves. The server and the agents
// run in their own LaunchAgent, so quitting this closes a window and stops nothing.
import AppKit
import WebKit

private let home = URL(string: "http://localhost:7777/?view=city")!
private func isJarvis(_ url: URL?) -> Bool { url?.host == "localhost" && url?.port == 7777 }
private let offline = """
<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-content:center;text-align:center;background:#000;color:#f5f5f7;font:16px -apple-system">
<h2 style="margin:0 0 8px">Jarvis isn't answering yet</h2><p style="margin:0">Trying again every few seconds. Its server may still be starting.</p>
"""

@main
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var awake: NSObjectProtocol?
    private var retry: Timer?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.mainMenu = menu()
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = [] // Jarvis answers aloud without a click first
        if #available(macOS 14.0, *) { config.preferences.inactiveSchedulingPolicy = .none } // keeps listening behind other windows
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.isInspectable = true

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Jarvis"
        window.contentView = web
        window.collectionBehavior = [.fullScreenPrimary]
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.toggleFullScreen(nil)
        awake = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Listening for Jarvis")
        goHome()
    }

    private func goHome() { retry?.invalidate(); retry = nil; web.load(URLRequest(url: home)) }

    // Clicking the Dock icon brings the one window back; closing it quits the app, not Jarvis.
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // Server down or restarting: say so and keep trying.
    func webView(_ view: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        view.loadHTMLString(offline, baseURL: nil)
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in self?.goHome() }
    }

    // Only Jarvis stays in this window. Anything else goes to the default browser.
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if isJarvis(url) || url?.scheme == "about" { decisionHandler(.allow); return }
        if let url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ view: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // The microphone is for Jarvis's own page only. macOS still asks the owner once.
    func webView(_ view: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "localhost" && origin.port == 7777 && type == .microphone ? .grant : .deny)
    }

    func webView(_ view: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.runModal(); completionHandler()
    }
    func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    @objc private func reload() { goHome() }

    private func menu() -> NSMenu {
        let bar = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) { let top = NSMenuItem(); let m = NSMenu(title: title); items.forEach(m.addItem); top.submenu = m; bar.addItem(top) }
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key); i.keyEquivalentModifierMask = mods; return i
        }
        add("Jarvis", [item("Hide Jarvis", #selector(NSApplication.hide(_:)), "h"), .separator(), item("Quit Jarvis", #selector(NSApplication.terminate(_:)), "q")])
        // Without these, copy and paste do nothing in a text field.
        add("Edit", [item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
                     item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"), item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a")])
        let refresh = item("Reload", #selector(reload), "r"); refresh.target = self
        add("View", [refresh, item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.control, .command])])
        add("Window", [item("Minimize", #selector(NSWindow.miniaturize(_:)), "m"), item("Close", #selector(NSWindow.performClose(_:)), "w")])
        return bar
    }
}

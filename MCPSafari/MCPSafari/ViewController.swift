//
//  ViewController.swift
//  MCPSafari
//
//  Created by Nick Paterno on 3/23/26.
//

import Cocoa
import SafariServices
import WebKit

nonisolated let extensionBundleIdentifier = "com.epistates.MCPSafari.Extension"
nonisolated private let accessibilitySettingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)

        // Enabling the extension happens in Safari, so the answer this window is
        // showing goes stale the moment the user acts on it. Re-ask whenever they
        // come back, rather than making them relaunch to see that it worked.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationDidBecomeActive),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func applicationDidBecomeActive() {
        Self.updateExtensionStateDisplay(for: webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Self.updateExtensionStateDisplay(for: webView)
    }

    private nonisolated static func updateExtensionStateDisplay(for webView: WKWebView) {
        let completion: @Sendable (SFSafariExtensionState?, Error?) -> Void = { (state, error) in
            // No state is not the same as "not enabled". Saying "Not enabled"
            // here would send someone to Safari to tick a box that may already
            // be ticked, so the failure is reported as its own state.
            let isEnabled = error == nil ? state?.isEnabled : nil
            if let error {
                NSLog("Could not read Safari extension state: \(error.localizedDescription)")
            }

            DispatchQueue.main.async {
                webView.evaluateJavaScript("show(\(isEnabled.map(String.init) ?? "null"))")
            }
        }

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier, completionHandler: completion)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let action = message.body as? String else { return }

        switch action {
        case "open-preferences":
            // Safari refuses this when it cannot resolve the extension, which
            // happens while a development build is registered in place of the
            // installed one. Discarding the error made the button look dead,
            // and a dead button is the one outcome that tells nobody anything.
            // The state read above already reports its own failure; this now
            // matches it rather than failing silently.
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { [weak self] error in
                guard let error else { return }
                NSLog("Could not open Safari extension preferences: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    guard let webView = self?.webView,
                          // Escaped through JSON rather than interpolated: the
                          // message comes from Safari and lands in a script.
                          let data = try? JSONSerialization.data(withJSONObject: [error.localizedDescription]),
                          let json = String(data: data, encoding: .utf8) else { return }
                    webView.evaluateJavaScript("showPreferencesError(\(json)[0])")
                }
            }
        case "enable-native-input":
            NSWorkspace.shared.open(accessibilitySettingsURL)
        default:
            break
        }
    }

}

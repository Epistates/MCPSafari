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

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Self.updateExtensionStateDisplay(for: webView)
    }

    private nonisolated static func updateExtensionStateDisplay(for webView: WKWebView) {
        let completion: @Sendable (SFSafariExtensionState?, Error?) -> Void = { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            let isEnabled = state.isEnabled

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(isEnabled), false)")
                }
            }
        }

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier, completionHandler: completion)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as! String != "open-preferences") {
            return;
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }

}

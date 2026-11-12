import Cocoa
import WebKit
import OSLog
@preconcurrency import ApplicationServices
import Carbon

private struct HubSnapshot: Decodable { let hub_root: String }
private struct Appearance: Decodable { let theme: String }
private struct UsageSchema: Decodable { let schema_version: Int }
private struct ProjectSchema: Decodable { let schema_version: Int }

@MainActor
final class HubApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var service: Process?
    private var startup: Task<Void, Never>?
    private var root: URL?
    private let baseURL = URL(string: "http://127.0.0.1:4317/")!
    private let logger = Logger(subsystem: "com.aihub.desktop", category: "desktop")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(self, name: "appearance")
        config.userContentController.add(self, name: "permissions")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "AI Hub"
        window.minSize = NSSize(width: 980, height: 680)
        window.contentView = webView
        window.setFrameAutosaveName("AIHubWorkspace")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("""
        <html lang="zh-CN"><meta charset="utf-8"><body style="background:#f5f6f9;color:#202b3b;font:15px -apple-system;padding:90px"><h1>AI Hub</h1><p>正在连接你的本地工作空间…</p></body></html>
        """, baseURL: nil)
        startup = Task { await connect() }
    }

    private func buildMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 AI Hub", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 AI Hub", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 AI Hub", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); menu.addItem(editItem)
        let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let viewItem = NSMenuItem(title: "显示", action: nil, keyEquivalent: ""); menu.addItem(viewItem)
        let view = NSMenu(title: "显示"); viewItem.submenu = view
        let reload = view.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r"); reload.target = self
        let browser = view.addItem(withTitle: "在浏览器中打开", action: #selector(openBrowser), keyEquivalent: "b"); browser.target = self
        NSApp.mainMenu = menu
    }

    private func locateHub() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        let candidate = environment["AI_HUB_ROOT"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ai-hub")
        if isHub(candidate) { return candidate.resolvingSymlinksInPath() }
        let panel = NSOpenPanel()
        panel.title = "选择 AI Hub 维护源目录"
        panel.message = "请选择包含 RULE.md 和 manifest.tsv 的 AI Hub 文件夹。"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let selected = panel.url, isHub(selected) else { return nil }
        return selected.resolvingSymlinksInPath()
    }

    private func isHub(_ url: URL) -> Bool {
        ["RULE.md", "manifest.tsv", "rules/global.md", "ui/projects.json"].allSatisfy {
            FileManager.default.fileExists(atPath: url.appendingPathComponent($0).path)
        }
    }

    private func fetch<Value: Decodable>(_ path: String, as type: Value.Type) async throws -> Value {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(type, from: data)
    }

    private func connect() async {
        guard let hub = locateHub() else { showError("未选择可用的 AI Hub 目录。请重新打开 App 后选择维护源。"); return }
        root = hub
        do {
            // 检查已有监听者的身份和根目录，避免连接到另一份工作空间。
            let snapshot = try await fetch("api/snapshot", as: HubSnapshot.self)
            guard URL(fileURLWithPath: snapshot.hub_root).resolvingSymlinksInPath() == hub else {
                showError("4317 端口正在服务另一份 Hub。请先关闭对应服务，再重新载入。"); return
            }
            let appearance = try await fetch("api/preferences", as: Appearance.self)
            let usage = try await fetch("api/usage", as: UsageSchema.self)
            guard usage.schema_version == 2 else { throw URLError(.badServerResponse) }
            let projects = try await fetch("api/projects/capabilities", as: ProjectSchema.self)
            guard projects.schema_version == 1 else { throw URLError(.badServerResponse) }
            setAppearance(appearance.theme)
            webView.load(URLRequest(url: baseURL))
            return
        } catch {
            if let urlError = error as? URLError, [.cannotConnectToHost, .networkConnectionLost].contains(urlError.code) {
                // 仅连接被拒绝时启动自有服务；不终止或替换占用端口的其他进程。
            } else {
                showError("本地服务版本不兼容或仍在启动。若正在运行旧版服务，请先退出它，再重新载入。\n\(error.localizedDescription)"); return
            }
        }
        do {
            try startService(hub)
            for _ in 0..<30 {
                try Task.checkCancellation()
                guard service?.isRunning == true else { throw URLError(.cannotConnectToHost) }
                if let snapshot = try? await fetch("api/snapshot", as: HubSnapshot.self),
                   URL(fileURLWithPath: snapshot.hub_root).resolvingSymlinksInPath() == hub {
                    let appearance = try await fetch("api/preferences", as: Appearance.self)
                    setAppearance(appearance.theme)
                    webView.load(URLRequest(url: baseURL)); return
                }
                try await Task.sleep(for: .milliseconds(250))
            }
            throw URLError(.timedOut)
        } catch is CancellationError {
            return
        } catch {
            logger.error("Local service startup failed: \(error.localizedDescription, privacy: .public)")
            showError("本地服务未能启动。请确认 Python 3.9+ 与 Git 可用，Hub 路径正确。\n\(error.localizedDescription)")
        }
    }

    private func startService(_ hub: URL) throws {
        guard let resources = Bundle.main.resourceURL else { throw URLError(.fileDoesNotExist) }
        let paths = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        guard let python = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw URLError(.fileDoesNotExist) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = [resources.appendingPathComponent("preview_hub.py").path, "--port", "4317", "--assets", resources.appendingPathComponent("web").path]
        var environment = ProcessInfo.processInfo.environment
        environment["AI_HUB_ROOT"] = hub.path
        environment["AI_HUB_DESKTOP_APP"] = Bundle.main.bundleURL.path
        environment["AI_HUB_RULES_BRIDGE"] = Bundle.main.executableURL?.path
        environment["AI_HUB_PROJECT_PICKER"] = resources.appendingPathComponent("ProjectPicker.app/Contents/MacOS/AIHubProjectPicker").path
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["LANG"] = "en_US.UTF-8"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        service = process
    }

    private func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "AI Hub 尚未就绪"; alert.informativeText = message
        alert.addButton(withTitle: "知道了"); alert.runModal()
    }

    private func setAppearance(_ theme: String) {
        window.appearance = NSAppearance(named: ["midnight", "plum"].contains(theme) ? .darkAqua : .aqua)
        let colors: [String: UInt32] = ["graphite": 0xf5f6f9, "midnight": 0x101722, "forest": 0xf2f6f3, "plum": 0x18151f]
        let color = colors[theme] ?? 0xf5f6f9
        window.backgroundColor = NSColor(srgbRed: CGFloat((color >> 16) & 255)/255, green: CGFloat((color >> 8) & 255)/255, blue: CGFloat(color & 255)/255, alpha: 1)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isLocal(message.frameInfo.request.url), let value = message.body as? String else { return }
        if message.name == "permissions", value == "accessibility" {
            // 只在用户主动打开权限入口时请求，后台检测不弹系统授权。
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        } else if message.name == "appearance" { setAppearance(value) }
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == 4317
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isLocal(url) || url.absoluteString == "about:blank" { decisionHandler(.allow) }
        else {
            if navigationAction.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        guard frame.isMainFrame, isLocal(frame.request.url) else {
            completionHandler(nil)
            return
        }

        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    @objc private func reloadPage() {
        if isLocal(webView.url) { webView.reload() }
        else { startup?.cancel(); startup = Task { await connect() } }
    }
    @objc private func openBrowser() { NSWorkspace.shared.open(baseURL) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        startup?.cancel()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "appearance")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "permissions")
        if service?.isRunning == true { service?.terminate() }
    }
}


// 规则脚本只来自已签名应用资源，动作白名单与后端适配器一致。
// 在应用自己的进程执行，避免系统把多层外部解释器当成另一个授权主体。
func scriptResult(_ script: NSAppleScript, arguments: [String]? = nil) -> (String?, NSDictionary?) {
    var failure: NSDictionary?
    let result: NSAppleEventDescriptor
    if let arguments {
        let values = NSAppleEventDescriptor.list()
        for (index, value) in arguments.enumerated() { values.insert(NSAppleEventDescriptor(string: value), at: index + 1) }
        let parameters = NSAppleEventDescriptor.list()
        parameters.insert(values, at: 1)
        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kASAppleScriptSuite), eventID: AEEventID(kASSubroutineEvent), targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        event.setParam(NSAppleEventDescriptor(string: "hubRules"), forKeyword: AEKeyword(keyASSubroutineName))
        event.setParam(parameters, forKeyword: AEKeyword(keyDirectObject))
        result = script.executeAppleEvent(event, error: &failure)
    } else {
        result = script.executeAndReturnError(&failure)
    }
    return (result.stringValue, failure)
}

func rulesBridge(_ arguments: [String]) -> Int32 {
    let trusted = AXIsProcessTrusted()
    if arguments == ["--rules-probe"] {
        var status = trusted ? "ready" : "accessibility_denied"
        let probeSource = """
        tell application "System Events"
            if not (exists process "Cursor") then return "not_running"
            get count of windows of process "Cursor"
            return "ready"
        end tell
        """
        if trusted, let script = NSAppleScript(source: probeSource) {
            let (value, failure) = scriptResult(script)
            if let failure {
                status = (failure[NSAppleScript.errorNumber] as? Int) == -1743 ? "automation_denied" : "read_denied"
            } else { status = value ?? "unknown" }
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["status": status, "native_trusted": trusted]) {
            FileHandle.standardOutput.write(data)
        }
        return 0
    }
    guard arguments.first == "--cursor-rules", arguments.count >= 2,
          ["read", "list", "get", "update", "add"].contains(arguments[1]),
          arguments.count == (["read", "list"].contains(arguments[1]) ? 2 : 5) else { return 2 }
    guard trusted else {
        FileHandle.standardError.write(Data("execution error: 当前 AI Hub 未获得辅助功能授权。 (-25211)".utf8)); return 1
    }
    guard let url = Bundle.main.resourceURL?.appendingPathComponent("cursor_rules.applescript") else { return 2 }
    guard let source = try? String(contentsOf: url, encoding: .utf8), source.contains("on run argv"),
          let script = NSAppleScript(source: source.replacingOccurrences(of: "on run argv", with: "on hubRules(argv)").replacingOccurrences(of: "end run", with: "end hubRules")) else { return 2 }
    var loadingError: NSDictionary?
    guard script.compileAndReturnError(&loadingError) else { return 2 }
    let (value, failure) = scriptResult(script, arguments: Array(arguments.dropFirst()))
    if let failure {
        let number = failure[NSAppleScript.errorNumber] as? Int ?? -1
        let message = failure[NSAppleScript.errorMessage] as? String ?? "Cursor 原生操作失败。"
        FileHandle.standardError.write(Data("execution error: \(message) (\(number))".utf8)); return 1
    }
    FileHandle.standardOutput.write(Data((value ?? "").utf8))
    return 0
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--cursor-rules" || arguments.first == "--rules-probe" {
    exit(rulesBridge(arguments))
}
let app = NSApplication.shared
let delegate = HubApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

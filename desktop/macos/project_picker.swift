import Cocoa

@MainActor
final class ProjectPicker: NSObject, NSApplicationDelegate {
    let returnApplication: NSRunningApplication?

    init(returnApplication: NSRunningApplication?) {
        self.returnApplication = returnApplication
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) {
            NSApp.abortModal()
            NSApp.terminate(nil)
        }
        DispatchQueue.main.async { self.chooseDirectory() }
    }

    private func chooseDirectory() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = "选择工程文件夹"
        panel.message = "选择要添加到 AI Hub 的本地工程。"
        panel.prompt = "选择此文件夹"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.resolvesAliases = true
        let result = panel.runModal()
        let payload: [String: String]
        if result == .OK, let selected = panel.url {
            payload = ["status": "selected", "path": selected.standardizedFileURL.resolvingSymlinksInPath().path]
        } else {
            payload = ["status": "cancelled"]
        }
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--result" {
                let output = URL(fileURLWithPath: CommandLine.arguments[2])
                try? data.write(to: output, options: .atomic)
                try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
            } else {
                FileHandle.standardOutput.write(data)
            }
        }
        if returnApplication?.bundleIdentifier != "com.aihub.desktop.picker" {
            returnApplication?.activate(options: [.activateIgnoringOtherApps])
        }
        NSApp.terminate(nil)
    }
}

let returnApplication = NSWorkspace.shared.frontmostApplication
let application = NSApplication.shared
let picker = ProjectPicker(returnApplication: returnApplication)
application.delegate = picker
application.setActivationPolicy(.accessory)
application.run()

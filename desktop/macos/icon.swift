import AppKit

// 本地矢量绘制，不依赖远程图片或额外资源。
let target = URL(fileURLWithPath: CommandLine.arguments[1])
let iconset = target.appendingPathComponent("AIHub.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let s = CGFloat(pixels)
        NSColor(srgbRed: 0.10, green: 0.17, blue: 0.29, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: s * 0.04, y: s * 0.04, width: s * 0.92, height: s * 0.92), xRadius: s * 0.21, yRadius: s * 0.21).fill()
        let path = NSBezierPath(); path.lineWidth = s * 0.055; path.lineCapStyle = .round
        path.move(to: NSPoint(x: s * 0.31, y: s * 0.27)); path.line(to: NSPoint(x: s * 0.31, y: s * 0.73))
        path.move(to: NSPoint(x: s * 0.69, y: s * 0.27)); path.line(to: NSPoint(x: s * 0.69, y: s * 0.73))
        path.move(to: NSPoint(x: s * 0.31, y: s * 0.50)); path.line(to: NSPoint(x: s * 0.69, y: s * 0.50))
        NSColor(srgbRed: 0.84, green: 0.91, blue: 1, alpha: 1).setStroke(); path.stroke()
        NSColor(srgbRed: 0.38, green: 0.63, blue: 1, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: s * 0.43, y: s * 0.43, width: s * 0.14, height: s * 0.14)).fill()
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let filename = "icon_\(size)x\(size)" + (scale == 2 ? "@2x" : "") + ".png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: iconset.appendingPathComponent(filename))
    }
}
let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", target.appendingPathComponent("AIHub.icns").path]
try process.run(); process.waitUntilExit()
if process.terminationStatus != 0 { exit(process.terminationStatus) }
try FileManager.default.removeItem(at: iconset)

import AppKit

struct BrandIcon: Decodable {
    let size: CGFloat
    let radius: CGFloat
    let background: String
    let foreground: String
    let shapes: [[[CGFloat]]]
}

func color(_ hex: String) -> NSColor {
    guard let value = UInt32(hex.dropFirst(), radix: 16) else {
        fatalError("品牌图标颜色必须使用十六进制 RGB")
    }
    return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
                   green: CGFloat((value >> 8) & 255) / 255,
                   blue: CGFloat(value & 255) / 255, alpha: 1)
}

let target = URL(fileURLWithPath: CommandLine.arguments[1])
let source = URL(fileURLWithPath: CommandLine.arguments[2])
let brand = try JSONDecoder().decode(BrandIcon.self, from: Data(contentsOf: source))
let iconset = target.appendingPathComponent("AIHub.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                      isPlanar: false, colorSpaceName: .deviceRGB,
                                      bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let side = CGFloat(pixels)
        let inset = side * 0.04
        let tile = side - inset * 2
        let unit = tile / brand.size
        color(brand.background).setFill()
        NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: tile, height: tile),
                     xRadius: brand.radius * unit, yRadius: brand.radius * unit).fill()

        // 与侧栏共用几何定义，将 SVG 的向下坐标换算到 AppKit。
        color(brand.foreground).setFill()
        for points in brand.shapes {
            let path = NSBezierPath()
            let first = points[0]
            path.move(to: NSPoint(x: inset + first[0] * unit, y: side - inset - first[1] * unit))
            for point in points.dropFirst() {
                path.line(to: NSPoint(x: inset + point[0] * unit, y: side - inset - point[1] * unit))
            }
            path.close()
            path.fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        let filename = "icon_\(size)x\(size)" + (scale == 2 ? "@2x" : "") + ".png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: iconset.appendingPathComponent(filename))
    }
}

let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", target.appendingPathComponent("AIHub.icns").path]
try process.run()
process.waitUntilExit()
if process.terminationStatus != 0 { exit(process.terminationStatus) }
try FileManager.default.removeItem(at: iconset)

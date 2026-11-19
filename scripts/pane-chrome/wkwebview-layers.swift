// Draws a page as the macOS app shows it, in the system WebKit: an off-screen
// WKWebView that never takes focus or shows in the Dock, rendered from the
// layer tree WebKit hands the window (CALayer.render), so a box WebKit
// composites on a layer of its own (a strip that scrolls) lands where the
// screen puts it. WKWebView's own snapshot paints the page flat in one pass
// and hides that. For title-tab-webkit.ts.
//
//   swift scripts/pane-chrome/wkwebview-layers.swift <url> <width>x<height> <scale> <out> <expression>
//
// Polls <expression> until it gives a string, waits half a second, reads it
// again and writes it to <out>.json and the picture at <scale> to <out>.png.
// <scale> 2 draws as a Retina screen does, whatever this Mac's screen is.
import AppKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count == 6, let url = URL(string: arguments[1]), let scale = Double(arguments[3]) else {
  FileHandle.standardError.write("usage: swift wkwebview-layers.swift <url> <width>x<height> <scale> <out> <expression>\n".data(using: .utf8)!)
  exit(2)
}
let dimensions = arguments[2].split(separator: "x").compactMap { Double($0) }
guard dimensions.count == 2 else { exit(2) }
let size = NSSize(width: dimensions[0], height: dimensions[1])
let out = arguments[4]
let expression = arguments[5]

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
// No App Nap: an app with no window on screen is throttled, and WebKit then
// lets go of the page's layers.
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "Drawing a page")

// Far off every screen, so nothing shows; ordered in, so WebKit draws it.
let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: size.width, height: size.height),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.ignoresMouseEvents = true
let web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: WKWebViewConfiguration())
window.contentView = web
// The device scale WebKit lays out and draws its layers at (WKWebView's
// `_setOverrideDeviceScaleFactor:`, which Safari's responsive design mode uses).
let override = NSSelectorFromString("_setOverrideDeviceScaleFactor:")
guard web.responds(to: override) else { fail("This WebKit cannot draw at another device scale.") }
typealias SetScale = @convention(c) (AnyObject, Selector, CGFloat) -> Void
unsafeBitCast(web.method(for: override), to: SetScale.self)(web, override, CGFloat(scale))
// Off screen, the window reads as hidden, and WebKit stops drawing a hidden
// page and lets go of its layers (`_setWindowOcclusionDetectionEnabled:`).
let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
if web.responds(to: occlusion) {
  typealias SetFlag = @convention(c) (AnyObject, Selector, Bool) -> Void
  unsafeBitCast(web.method(for: occlusion), to: SetFlag.self)(web, occlusion, false)
}
window.orderFrontRegardless()
web.load(URLRequest(url: url))

func render() {
  let width = Int(size.width * scale), height = Int(size.height * scale)
  guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
        let layer = web.layer else { fail("Could not draw the view's layers.") }
  context.translateBy(x: 0, y: CGFloat(height))
  context.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
  layer.render(in: context)
  guard let image = context.makeImage() else { fail("The layers drew nothing.") }
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let png = bitmap.representation(using: .png, properties: [:]) else { fail("Could not encode the picture.") }
  do {
    try png.write(to: URL(fileURLWithPath: "\(out).png"))
  } catch {
    fail("Could not write \(out): \(error)")
  }
}

var tries = 0
func poll() {
  web.evaluateJavaScript(expression) { result, _ in
    guard result is String else {
      tries += 1
      if tries > 300 { fail("The page gave nothing for the expression within 30 s.") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: poll)
      return
    }
    // Past effects, measures and colour transitions.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      web.evaluateJavaScript(expression) { settled, _ in
        guard let json = settled as? String else { fail("The page stopped giving a value for the expression.") }
        do {
          try json.write(toFile: "\(out).json", atomically: true, encoding: .utf8)
        } catch {
          fail("Could not write \(out).json: \(error)")
        }
        render()
        exit(0)
      }
    }
  }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: poll)
app.run()

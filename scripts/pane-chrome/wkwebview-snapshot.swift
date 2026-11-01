// Pictures a page in the system WebKit, the engine the macOS desktop app
// draws with, for badge-ink.ts: an off-screen WKWebView that never takes
// focus or shows in the Dock. It loads the URL, waits for the page to
// publish `window.__badgeInk`, and writes <out>.json (that layout) and
// <out>.png (the viewport at the screen's scale, 2x on a Retina Mac).
//
//   swift scripts/pane-chrome/wkwebview-snapshot.swift <url> <width>x<height> <out>
import AppKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count == 4, let url = URL(string: arguments[1]) else {
  FileHandle.standardError.write("usage: swift wkwebview-snapshot.swift <url> <width>x<height> <out>\n".data(using: .utf8)!)
  exit(2)
}
let dimensions = arguments[2].split(separator: "x").compactMap { Double($0) }
guard dimensions.count == 2 else { exit(2) }
let size = NSSize(width: dimensions[0], height: dimensions[1])
let out = arguments[3]

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
  exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

// Far off every screen, so nothing shows; ordered in, so WebKit draws it.
let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: size.width, height: size.height),
                      styleMask: [.borderless], backing: .buffered, defer: false)
let web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: WKWebViewConfiguration())
window.contentView = web
window.orderFrontRegardless()
web.load(URLRequest(url: url))

var tries = 0
func poll() {
  web.evaluateJavaScript("window.__badgeInk ? JSON.stringify(window.__badgeInk) : null") { result, _ in
    guard let json = result as? String else {
      tries += 1
      if tries > 300 { fail("The page did not publish window.__badgeInk within 30 s.") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: poll)
      return
    }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = web.bounds
    configuration.afterScreenUpdates = true
    web.takeSnapshot(with: configuration) { image, error in
      guard let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:]) else {
        fail("The snapshot failed: \(error?.localizedDescription ?? "no image")")
      }
      do {
        try json.write(toFile: "\(out).json", atomically: true, encoding: .utf8)
        try png.write(to: URL(fileURLWithPath: "\(out).png"))
      } catch {
        fail("Could not write \(out): \(error)")
      }
      print("\(out).png \(bitmap.pixelsWide)x\(bitmap.pixelsHigh)")
      exit(0)
    }
  }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: poll)
app.run()

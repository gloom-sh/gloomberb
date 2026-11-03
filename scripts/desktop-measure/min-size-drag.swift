// Drags the bottom right corner of the app's window far past its minimum
// size with real mouse events, and reads the window's size after every move
// while the button is held: the window has to stop at the minimum, never go
// under it and jump back once the button is let go. macOS only.
//
//   swiftc -O scripts/desktop-measure/min-size-drag.swift -o min-size-drag
//   ./min-size-drag --app /Applications/Gloom.app --min 640x400 --out result.json [--require]
//
// Starts the app, waits for its window, drags, quits it. Writes what it saw to
// --out; with --require it exits 1 when the window went under the minimum or
// did not end at it.
import AppKit
import CoreGraphics
import Foundation

func option(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

guard let appPath = option("--app"), let minText = option("--min"), let outPath = option("--out") else {
  FileHandle.standardError.write("usage: min-size-drag --app <Gloom.app> --min <width>x<height> --out <file> [--require]\n".data(using: .utf8)!)
  exit(2)
}
let required = CommandLine.arguments.contains("--require")
let minParts = minText.split(separator: "x").compactMap { Double($0) }
let minimum = CGSize(width: minParts[0], height: minParts[1])
let bundlePath = URL(fileURLWithPath: appPath).standardizedFileURL.path

func processPath(_ pid: pid_t) -> String? {
  var buffer = [CChar](repeating: 0, count: 4096)
  return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
}

/// The app's biggest ordinary window on screen, in global top-left points, with its owner.
func appWindow() -> (bounds: CGRect, pid: pid_t)? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  var best: (bounds: CGRect, pid: pid_t)?
  for info in list {
    guard (info[kCGWindowLayer as String] as? Int) == 0,
          let pid = info[kCGWindowOwnerPID as String] as? pid_t,
          let path = processPath(pid), path.hasPrefix(bundlePath + "/"),
          let raw = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: raw) else { continue }
    if best == nil || bounds.width * bounds.height > best!.bounds.width * best!.bounds.height { best = (bounds, pid) }
  }
  return best
}

func post(_ type: CGEventType, _ point: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func sleepMs(_ ms: Int) { usleep(useconds_t(ms * 1000)) }

var result: [String: Any] = ["minimum": ["width": minimum.width, "height": minimum.height]]
func finish(_ passed: Bool, _ detail: String) -> Never {
  result["passed"] = passed
  result["detail"] = detail
  if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
    FileManager.default.createFile(atPath: outPath, contents: data)
  }
  print("\(passed ? "pass" : "fail"): \(detail)")
  // Quits every process of the app this started.
  let quit = Process()
  quit.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
  quit.arguments = ["-f", bundlePath + "/Contents/"]
  try? quit.run()
  quit.waitUntilExit()
  try? FileManager.default.removeItem(atPath: profile)
  exit(required && !passed ? 1 : 0)
}

let launch = Process()
launch.executableURL = URL(fileURLWithPath: bundlePath + "/Contents/MacOS/launcher")
// A profile of its own, as scripts/desktop-measure/measure.ts gives each launch.
let profile = FileManager.default.temporaryDirectory.appendingPathComponent("gloom-min-size-\(getpid())").path
try? FileManager.default.createDirectory(atPath: profile, withIntermediateDirectories: true)
launch.environment = ProcessInfo.processInfo.environment.merging(["GLOOMBERB_HOME": profile, "GLOOMBERB_NO_TELEMETRY": "1", "DO_NOT_TRACK": "1"]) { _, new in new }
do { try launch.run() } catch { finish(false, "could not start the app: \(error)") }

var found: (bounds: CGRect, pid: pid_t)?
for _ in 0..<180 {
  if let window = appWindow(), window.bounds.width > 200 { found = window; break }
  sleepMs(500)
}
guard var window = found else { finish(false, "no window of the app came within 90 s") }
// The page draws, and the window settles where the app puts it.
sleepMs(6000)
window = appWindow() ?? window
NSRunningApplication(processIdentifier: window.pid)?.activate(options: [])
sleepMs(800)
window = appWindow() ?? window
let before = window.bounds
result["before"] = ["x": before.minX, "y": before.minY, "width": before.width, "height": before.height]

let grab = CGPoint(x: before.maxX - 2, y: before.maxY - 2)
let target = CGPoint(x: before.minX + minimum.width / 3, y: before.minY + minimum.height / 3)
// Read as often as it can, between the moves too: a size the window takes
// under the minimum and gives back a few milliseconds later is the jump this
// looks for. Each size is kept once in a row.
var samples: [[String: Double]] = []
var readings = 0
func sample() {
  guard let bounds = appWindow()?.bounds else { return }
  readings += 1
  if let last = samples.last, last["width"] == bounds.width, last["height"] == bounds.height { return }
  samples.append(["width": bounds.width, "height": bounds.height])
}
func sample(forMs ms: Double) {
  let end = Date().addingTimeInterval(ms / 1000)
  while Date() < end { sample() }
}

post(.mouseMoved, grab)
sleepMs(300)
post(.leftMouseDown, grab)
sleepMs(150)
let steps = 30
for step in 1...steps {
  let progress = CGFloat(step) / CGFloat(steps)
  post(.leftMouseDragged, CGPoint(x: grab.x + (target.x - grab.x) * progress, y: grab.y + (target.y - grab.y) * progress))
  sample(forMs: 30)
}
sample(forMs: 300)
post(.leftMouseUp, target)
sleepMs(1200)

let after = appWindow()?.bounds ?? .zero
result["after"] = ["x": after.minX, "y": after.minY, "width": after.width, "height": after.height]
result["samples"] = samples
result["readings"] = readings
let smallest = CGSize(width: samples.map { $0["width"]! }.min() ?? after.width, height: samples.map { $0["height"]! }.min() ?? after.height)
let under = samples.filter { $0["width"]! < minimum.width - 1 || $0["height"]! < minimum.height - 1 }
let resized = abs(after.width - before.width) > 2 || abs(after.height - before.height) > 2
let atMinimum = abs(after.width - minimum.width) <= 2 && abs(after.height - minimum.height) <= 2
var problems: [String] = []
if !resized { problems.append("the drag did not resize the window (no input reached it?)") }
if !under.isEmpty { problems.append("went under the minimum while held (\(under.count) of \(samples.count) sizes it took, down to \(Int(smallest.width))x\(Int(smallest.height)))") }
if !atMinimum { problems.append("ended at \(Int(after.width))x\(Int(after.height))") }
let summary = "minimum \(Int(minimum.width))x\(Int(minimum.height)); \(Int(before.width))x\(Int(before.height)) -> \(Int(after.width))x\(Int(after.height)), smallest while held \(Int(smallest.width))x\(Int(smallest.height)) (\(readings) readings, \(samples.count) sizes)"
finish(problems.isEmpty, (problems + [summary]).joined(separator: "; "))

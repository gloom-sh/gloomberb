// Prototype: the Gloom desktop shell on Tauri. The desktop backend runs
// unchanged in a Bun sidecar (backend/index.js, with `electrobun/bun` replaced
// by src/renderers/tauri/electrobun-bun.ts). This process owns the windows:
// it makes and drives them on the sidecar's commands, and reports their
// events and the displays back.
//
// Sidecar protocol: commands arrive on the sidecar's stdout as lines that
// start with "\u{1}GLOOM " followed by JSON; anything else the sidecar prints
// is passed through to stderr. Events go to the sidecar's stdin as JSON lines.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const COMMAND_PREFIX: &str = "\u{1}GLOOM ";

struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

fn emit(app: &AppHandle, value: Value) {
    if let Some(state) = app.try_state::<Sidecar>() {
        if let Some(stdin) = state.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{}", value);
            let _ = stdin.flush();
        }
    }
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Value {
    json!({ "x": x.round(), "y": y.round(), "width": width.round(), "height": height.round() })
}

fn displays(app: &AppHandle) -> Value {
    let primary = app.primary_monitor().ok().flatten();
    let monitors = app.available_monitors().unwrap_or_default();
    let list: Vec<Value> = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let scale = monitor.scale_factor();
            let position = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            let work = monitor.work_area();
            let work_position = work.position.to_logical::<f64>(scale);
            let work_size = work.size.to_logical::<f64>(scale);
            let is_primary = primary
                .as_ref()
                .map(|p| p.position() == monitor.position() && p.size() == monitor.size())
                .unwrap_or(index == 0);
            json!({
                "id": index,
                "bounds": rect(position.x, position.y, size.width, size.height),
                "workArea": rect(work_position.x, work_position.y, work_size.width, work_size.height),
                "scaleFactor": scale,
                "isPrimary": is_primary,
            })
        })
        .collect();
    json!(list)
}

fn frame_of(window: &WebviewWindow) -> Value {
    let scale = window.scale_factor().unwrap_or(1.0);
    let position = window
        .outer_position()
        .map(|p| p.to_logical::<f64>(scale))
        .unwrap_or(LogicalPosition::new(0.0, 0.0));
    let size = window
        .outer_size()
        .map(|s| s.to_logical::<f64>(scale))
        .unwrap_or(LogicalSize::new(0.0, 0.0));
    rect(position.x, position.y, size.width, size.height)
}

fn window_state(window: &WebviewWindow, id: u64, event: &str) -> Value {
    json!({
        "event": event,
        "id": id,
        "frame": frame_of(window),
        "maximized": window.is_maximized().unwrap_or(false),
        "minimized": window.is_minimized().unwrap_or(false),
        "fullscreen": window.is_fullscreen().unwrap_or(false),
    })
}

fn number(value: &Value, key: &str, fallback: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}

fn create_window(app: &AppHandle, command: &Value) -> tauri::Result<()> {
    let id = command["id"].as_u64().unwrap_or(0);
    let label = format!("w{id}");
    let frame = &command["frame"];
    let mut init = String::new();
    // Measurement builds pass a probe that must run before the page's scripts.
    if let Ok(probe) = std::env::var("GLOOM_PROBE_SCRIPT") {
        init.push_str(&probe);
        init.push('\n');
    }
    init.push_str(command["initScript"].as_str().unwrap_or(""));

    let event_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(command["title"].as_str().unwrap_or("Gloom"))
        .initialization_script(&init)
        .inner_size(number(frame, "width", 1440.0), number(frame, "height", 920.0))
        .position(number(frame, "x", 64.0), number(frame, "y", 48.0))
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                emit(&event_app, json!({ "event": "dom-ready", "id": id }));
            }
        });
    if let Some(min) = command.get("minSize").filter(|v| v.is_object()) {
        builder = builder.min_inner_size(number(min, "width", 360.0), number(min, "height", 240.0));
    }
    #[cfg(target_os = "macos")]
    {
        // Electrobun's "hiddenInset": the page fills the window under the traffic lights.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The app's header is the title bar and draws the window buttons.
        builder = builder.decorations(false).shadow(true);
    }
    let window = builder.build()?;

    let event_app = app.clone();
    let event_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) => emit(&event_app, window_state(&event_window, id, "moved")),
        WindowEvent::Resized(_) => emit(&event_app, window_state(&event_window, id, "resized")),
        WindowEvent::Focused(focused) => {
            emit(&event_app, json!({ "event": "focus", "id": id, "focused": focused }))
        }
        WindowEvent::CloseRequested { .. } => {
            emit(&event_app, json!({ "event": "close-requested", "id": id }))
        }
        WindowEvent::Destroyed => emit(&event_app, json!({ "event": "closed", "id": id })),
        WindowEvent::ScaleFactorChanged { .. } => {
            emit(&event_app, json!({ "event": "displays", "displays": displays(&event_app) }))
        }
        _ => {}
    });
    Ok(())
}

fn window_for(app: &AppHandle, command: &Value) -> Option<WebviewWindow> {
    let id = command["id"].as_u64()?;
    app.get_webview_window(&format!("w{id}"))
}

fn handle_command(app: &AppHandle, command: Value) {
    let name = command["cmd"].as_str().unwrap_or("");
    let result: tauri::Result<()> = (|| {
        match name {
            "window.create" => create_window(app, &command)?,
            "app.quit" => app.exit(command["code"].as_i64().unwrap_or(0) as i32),
            _ => {
                let Some(window) = window_for(app, &command) else { return Ok(()) };
                match name {
                    "window.setFrame" => {
                        let frame = &command["frame"];
                        window.set_position(LogicalPosition::new(number(frame, "x", 0.0), number(frame, "y", 0.0)))?;
                        window.set_size(LogicalSize::new(number(frame, "width", 800.0), number(frame, "height", 600.0)))?;
                    }
                    "window.setTitle" => window.set_title(command["title"].as_str().unwrap_or(""))?,
                    "window.minimize" => window.minimize()?,
                    "window.unminimize" => window.unminimize()?,
                    "window.maximize" => window.maximize()?,
                    "window.unmaximize" => window.unmaximize()?,
                    "window.setFullScreen" => window.set_fullscreen(command["value"].as_bool().unwrap_or(false))?,
                    "window.setAlwaysOnTop" => window.set_always_on_top(command["value"].as_bool().unwrap_or(false))?,
                    "window.focus" => {
                        window.unminimize()?;
                        window.show()?;
                        window.set_focus()?;
                    }
                    "window.show" => window.show()?,
                    "window.hide" => window.hide()?,
                    "window.close" => window.close()?,
                    "window.eval" => window.eval(command["js"].as_str().unwrap_or(""))?,
                    _ => {}
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("[shell] {name} failed: {error}");
    }
}

fn spawn_sidecar(app: &AppHandle) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().expect("the app's folder");
    let bun = dir.join(if cfg!(windows) { "bun.exe" } else { "bun" });
    // Where the bundle put the resources: the platform's resource folder, or
    // beside the binary in an unpacked .deb or a dev build.
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("backend").join("index.js"));
    }
    candidates.push(dir.join("backend").join("index.js"));
    candidates.push(dir.join("..").join("lib").join("Gloom").join("backend").join("index.js"));
    candidates.push(dir.join("..").join("Resources").join("backend").join("index.js"));
    let script = candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    let mut command = Command::new(&bun);
    command
        .arg(&script)
        .current_dir(script.parent().unwrap_or(dir))
        .env("GLOOM_DESKTOP_SHELL", "tauri")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    app.manage(Sidecar {
        stdin: Mutex::new(stdin),
        child: Mutex::new(Some(child)),
    });
    emit(app, json!({ "event": "hello", "displays": displays(app) }));

    let reader_app = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Some(body) = line.strip_prefix(COMMAND_PREFIX) {
                match serde_json::from_str::<Value>(body) {
                    Ok(command) => {
                        let app = reader_app.clone();
                        let _ = reader_app.run_on_main_thread(move || handle_command(&app, command));
                    }
                    Err(error) => eprintln!("[shell] bad command: {error}"),
                }
            } else {
                eprintln!("{line}");
            }
        }
        // The backend is gone: so is the app.
        reader_app.exit(0);
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Tauri app");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Sidecar>() {
                if let Some(mut child) = state.child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}

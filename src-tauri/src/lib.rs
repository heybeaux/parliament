use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const SERVER_PORT: &str = "3000";

struct ServerState {
    child: Option<std::process::Child>,
}

fn bundled_node() -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/node-aarch64-apple-darwin")
    } else {
        // externalBin is copied next to the main exe in Contents/MacOS/
        std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("node")
    }
}

fn bundled_server_entry() -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("packages/server/dist/index.js")
    } else {
        // exe is Contents/MacOS/parliament-desktop; Resources is Contents/Resources/
        let exe = std::env::current_exe().unwrap();
        let contents = exe.parent().unwrap().parent().unwrap();
        contents.join("Resources/server/packages/server/dist/index.js")
    }
}

fn spawn_server() -> Option<std::process::Child> {
    let node_bin = bundled_node();
    let server_entry = bundled_server_entry();

    println!(
        "Parliament: spawning server
  node:  {}
  entry: {}",
        node_bin.display(),
        server_entry.display()
    );

    if !node_bin.exists() {
        eprintln!(
            "Parliament: node binary not found at {}
  Run: bash scripts/bundle-sidecar.sh",
            node_bin.display()
        );
        return None;
    }
    if !server_entry.exists() {
        eprintln!(
            "Parliament: server entry not found at {}
  Run: bash scripts/bundle-sidecar.sh",
            server_entry.display()
        );
        return None;
    }

    match std::process::Command::new(&node_bin)
        .arg(&server_entry)
        .env("PORT", SERVER_PORT)
        .env("PARLIAMENT_SERVER_HOST", "127.0.0.1")
        .spawn()
    {
        Ok(child) => {
            println!(
                "Parliament: server spawned (pid={}) on 127.0.0.1:{}",
                child.id(),
                SERVER_PORT
            );
            Some(child)
        }
        Err(e) => {
            eprintln!("Parliament: failed to spawn server: {e}");
            None
        }
    }
}

fn kill_server(state: &Mutex<ServerState>) {
    if let Ok(mut s) = state.lock() {
        if let Some(mut child) = s.child.take() {
            let _ = child.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Spawn server before entering Tauri event loop so it is ready when the webview loads
    let child = spawn_server();
    let server_state = Mutex::new(ServerState { child });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(server_state)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.app_handle().state::<Mutex<ServerState>>();
                kill_server(&state);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<Mutex<ServerState>>();
                kill_server(&state);
            }
        });
}

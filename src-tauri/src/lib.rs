use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

struct ServerState {
    child: Option<tauri_plugin_shell::process::CommandChild>,
}

fn app_dir() -> std::path::PathBuf {
    // In dev: project root. In production: app bundle Resources dir.
    if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    } else {
        std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("Resources")
    }
}

fn spawn_server(app: &AppHandle, state: &Mutex<ServerState>) {
    let node_path = which_node();
    let project_root = app_dir();
    let server_entry = project_root.join("packages/server/dist/index.js");

    println!("Parliament: spawning server via {} {}", node_path, server_entry.display());

    let result = app
        .shell()
        .command(&node_path)
        .arg(server_entry.to_str().unwrap())
        .env("PORT", "3001")
        .env("PARLIAMENT_SERVER_HOST", "127.0.0.1")
        .spawn();

    match result {
        Ok((_rx, child)) => {
            let mut s = state.lock().unwrap();
            s.child = Some(child);
            println!("Parliament: server process spawned (127.0.0.1:3000)");
        }
        Err(e) => {
            eprintln!("Parliament: failed to spawn server: {e}");
        }
    }
}

fn which_node() -> String {
    // Try common locations for node on macOS with mise/nvm/system
    let candidates = [
        "/Users/beauxwalton/.local/share/mise/installs/node/23.5.0/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "node",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    "node".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server_state = Mutex::new(ServerState { child: None });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(server_state)
        .setup(|app| {
            let state = app.state::<Mutex<ServerState>>();
            spawn_server(app.handle(), &state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                let state = app.state::<Mutex<ServerState>>();
                if let Ok(mut s) = state.lock() {
                    if let Some(child) = s.child.take() {
                        let _ = child.kill();
                    }
                };
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<Mutex<ServerState>>();
                if let Ok(mut s) = state.lock() {
                    if let Some(child) = s.child.take() {
                        let _ = child.kill();
                    }
                };
            }
        });
}

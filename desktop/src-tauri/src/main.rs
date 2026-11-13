use reqwest::blocking::Client;
use serde_json::Value;
use std::{
    fs,
    net::TcpListener,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

struct Backend {
    child: Arc<Mutex<Option<Child>>>,
    url: String,
    client: Client,
    quitting: AtomicBool,
}

#[derive(Clone, Default)]
struct Lifecycle {
    quitting: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

fn stop_child(child: &Mutex<Option<Child>>) {
    if let Some(mut child) = child.lock().unwrap().take() {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGTERM);
        }
        let _ = child.wait();
    }
}

impl Backend {
    fn stop(&self) {
        stop_child(&self.child);
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}

fn root() -> PathBuf {
    std::env::var_os("EASYREAD_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf()
        })
}

fn data_home(root: &std::path::Path) -> PathBuf {
    std::env::var_os("EASYREAD_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.to_path_buf())
}

fn read_info(root: &std::path::Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(data_home(root).join(".server.json")).ok()?).ok()
}

fn valid_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "http" && u.host_str() == Some("127.0.0.1") && u.port().is_some()
    })
}

fn service_matches(client: &Client, url: &str, root: &std::path::Path) -> bool {
    if !valid_url(url) {
        return false;
    }
    let Some(info) = read_info(root) else {
        return false;
    };
    let Ok(response) = client.get(format!("{url}/api/health")).send() else {
        return false;
    };
    let Ok(data) = response.json::<Value>() else {
        return false;
    };
    data["version"] == "easyread-accounts-1"
        && data["instance"].is_string()
        && data["instance"] == info["instance"]
}

fn start_backend(lifecycle: &Lifecycle) -> Result<Backend, Box<dyn std::error::Error>> {
    let root = root();
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()?;
    if let Some(url) = read_info(&root).and_then(|v| v["url"].as_str().map(str::to_owned)) {
        if service_matches(&client, &url, &root) {
            return Ok(Backend {
                child: lifecycle.child.clone(),
                url,
                client,
                quitting: AtomicBool::new(false),
            });
        }
    }
    let python = root.join(".venv/bin/python");
    if !python.exists() {
        return Err("找不到 Python 环境，请先运行项目里的 start.sh".into());
    }
    let port = fs::read(data_home(&root).join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| v["port"].as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .unwrap_or(8765);
    let expected_url = format!("http://127.0.0.1:{port}");
    if service_matches(&client, &expected_url, &root) {
        return Ok(Backend {
            child: lifecycle.child.clone(),
            url: expected_url,
            client,
            quitting: AtomicBool::new(false),
        });
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|_| {
        format!("端口 {port} 已被其他服务占用。请在 config.json 中设置另一个固定 port 后重试。")
    })?;
    drop(listener);
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("desktop.log"))?;
    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    let mut command = Command::new(python);
    command
        .args(["-m", "easyread", "serve", "--port", &port.to_string()])
        .current_dir(&root)
        .env("EASYREAD_HOME", data_home(&root))
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    {
        let mut child = lifecycle.child.lock().unwrap();
        if lifecycle.quitting.load(Ordering::SeqCst) {
            return Err("启动已取消".into());
        }
        *child = Some(command.spawn()?);
    }
    let mut backend = Backend {
        child: lifecycle.child.clone(),
        url: String::new(),
        client,
        quitting: AtomicBool::new(false),
    };
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if lifecycle.quitting.load(Ordering::SeqCst) {
            return Err("启动已取消".into());
        }
        if let Some(info) = read_info(&root) {
            let pid = backend.child.lock().unwrap().as_ref().unwrap().id();
            if info["pid"].as_u64() == Some(pid as u64) {
                if let Some(url) = info["url"].as_str() {
                    if url != expected_url {
                        return Err("启动时端口被占用，服务地址发生变化，请重试。".into());
                    }
                    if service_matches(&backend.client, url, &root) {
                        backend.url = url.to_owned();
                        return Ok(backend);
                    }
                }
            }
        }
        if backend
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()?
            .is_some()
        {
            return Err("本地服务启动失败，请查看 easyread/desktop.log".into());
        }
        if Instant::now() > deadline {
            return Err("本地服务启动超时，请查看 easyread/desktop.log".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn active_jobs(data: &Value) -> bool {
    let active = |job: &Value| matches!(job["state"].as_str(), Some("queued" | "running"));
    data["jobs"]
        .as_array()
        .is_some_and(|jobs| jobs.iter().any(active))
        || data["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| active(&item["job"])))
}

fn request_quit(app: &tauri::AppHandle) {
    let lifecycle = app.state::<Lifecycle>();
    let Some(state) = app.try_state::<Backend>() else {
        lifecycle.quitting.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    };
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    let token = read_info(&root())
        .and_then(|v| v["desktop_token"].as_str().map(str::to_owned))
        .unwrap_or_default();
    let status = state
        .client
        .get(format!("{}/api/desktop/status", state.url))
        .header("X-Desktop-Token", token)
        .send()
        .and_then(|r| r.json::<Value>());
    let owns_service = state.child.lock().unwrap().is_some();
    let message = match status {
        Ok(data) if data["dirty"] == true || ((data["active"] == true || active_jobs(&data)) && owns_service) => {
            Some("还有未保存的笔记或正在处理的任务。退出将放弃未保存修改并中断任务；已保存内容保留，AI请求可能已计费。确定退出吗？")
        }
        Err(_) => Some("暂时无法确认后台任务状态。确定退出 EasyRead 吗？"),
        _ => None,
    };
    if let Some(message) = message {
        let answer = rfd::MessageDialog::new()
            .set_title("退出 EasyRead")
            .set_description(message)
            .set_buttons(rfd::MessageButtons::YesNo)
            .show();
        if answer != rfd::MessageDialogResult::Yes {
            return;
        }
    }
    state.quitting.store(true, Ordering::SeqCst);
    lifecycle.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Lifecycle::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .setup(|app| {
            let nav_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("EasyRead")
                .inner_size(1280.0, 860.0)
                .min_inner_size(800.0, 580.0)
                // HTML drag/drop must receive PDFs instead of Tauri's native drop interception.
                .disable_drag_drop_handler()
                .on_new_window(|url, _| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_download(|_, event| {
                    if let tauri::webview::DownloadEvent::Requested { destination, .. } = event {
                        let name = destination
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("EasyRead-export.html");
                        if let Some(path) = rfd::FileDialog::new().set_file_name(name).save_file() {
                            *destination = path;
                        } else {
                            return false;
                        }
                    }
                    true
                })
                .on_navigation(move |url| {
                    if !matches!(url.scheme(), "http" | "https") {
                        return true;
                    }
                    if nav_handle
                        .try_state::<Backend>()
                        .is_some_and(|b| url.as_str().starts_with(&format!("{}/", b.url)))
                    {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
                    }
                    false
                })
                .build()?;
            let open = MenuItem::with_id(app, "show", "显示 EasyRead", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "在浏览器中打开", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 EasyRead", true, Some("CmdOrCtrl+Q"))?;
            let application = Submenu::with_items(
                app,
                "EasyRead",
                true,
                &[&open, &browser, &PredefinedMenuItem::separator(app)?, &quit],
            )?;
            let edit = Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&application, &edit])?)?;
            let handle = app.handle().clone();
            let lifecycle = app.state::<Lifecycle>().inner().clone();
            std::thread::spawn(move || {
                let result = start_backend(&lifecycle).map_err(|e| e.to_string());
                if lifecycle.quitting.load(Ordering::SeqCst) {
                    return;
                }
                let main_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || match result {
                    Ok(backend) => {
                        let url = backend.url.parse().unwrap();
                        main_handle.manage(backend);
                        if let Some(window) = main_handle.get_webview_window("main") {
                            let _ = window.navigate(url);
                        }
                    }
                    Err(error) => {
                        rfd::MessageDialog::new()
                            .set_title("EasyRead 无法启动")
                            .set_description(error)
                            .show();
                        request_quit(&main_handle);
                    }
                });
            });
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "browser" => {
                if let Some(state) = app.try_state::<Backend>() {
                    let _ = Command::new("/usr/bin/open").arg(&state.url).spawn();
                }
            }
            "quit" => request_quit(app),
            _ => (),
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("无法建立 EasyRead 桌面窗口");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if !app.state::<Lifecycle>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_quit(app);
            }
        }
        RunEvent::Reopen { .. } => show(app),
        RunEvent::Exit => {
            let lifecycle = app.state::<Lifecycle>();
            lifecycle.quitting.store(true, Ordering::SeqCst);
            stop_child(&lifecycle.child);
        }
        _ => (),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tracks_translation_and_chat_jobs() {
        assert!(active_jobs(
            &serde_json::json!({"items":[{"job":{"state":"running"}}]})
        ));
        assert!(active_jobs(
            &serde_json::json!({"jobs":[{"state":"queued"}]})
        ));
        assert!(!active_jobs(
            &serde_json::json!({"jobs":[{"state":"done"}],"items":[]})
        ));
    }
    #[test]
    fn accepts_only_loopback_service_urls() {
        assert!(valid_url("http://127.0.0.1:8765"));
        assert!(!valid_url("https://example.com:8765"));
        assert!(!valid_url("http://127.0.0.1.evil.test:8765"));
    }
}

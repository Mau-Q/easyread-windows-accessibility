//! Forward the existing Ctrl+Q command when WebView2 owns keyboard focus.
//! The browser consumes these messages before the native menu message loop.
use tauri::Manager;
use webview2_com::{
    AcceleratorKeyPressedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    },
};

#[link(name = "user32")]
extern "system" {
    fn GetKeyState(key: i32) -> i16;
}

fn quit_key(key: u32, ctrl: bool, alt: bool, shift: bool) -> bool {
    key == 0x51 && ctrl && !alt && !shift
}

pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    window.with_webview(move |view| {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            unsafe {
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                {
                    return Ok(());
                }
                let mut key = 0;
                args.VirtualKey(&mut key)?;
                if !quit_key(
                    key,
                    GetKeyState(0x11) < 0,
                    GetKeyState(0x12) < 0,
                    GetKeyState(0x10) < 0,
                ) {
                    return Ok(());
                }
                args.SetHandled(true)?;
                let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                args.PhysicalKeyStatus(&mut status)?;
                if status.WasKeyDown.as_bool() {
                    return Ok(());
                }
                // Per WebView2's AcceleratorKeyPressed contract, don't show a
                // modal dialog inside this synchronous input callback.
                let target = app.clone();
                std::thread::spawn(move || {
                    let handle = target.clone();
                    if let Err(error) =
                        target.run_on_main_thread(move || super::request_quit(&handle))
                    {
                        eprintln!("无法安排退出操作：{error}");
                    }
                });
            }
            Ok(())
        }));
        let mut token = 0;
        if let Err(error) = unsafe {
            view.controller()
                .add_AcceleratorKeyPressed(&handler, &mut token)
        } {
            rfd::MessageDialog::new()
                .set_title("退出快捷键初始化失败")
                .set_description(error.to_string())
                .show();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quit_routing_preserves_editing_and_assistive_keys() {
        assert!(quit_key(0x51, true, false, false));
        for (key, ctrl, alt, shift) in [
            (0x43, true, false, false),
            (0x56, true, false, false),
            (0x75, false, false, false),
            (0x79, false, false, true),
            (0x51, true, true, false),
            (0x51, true, false, true),
        ] {
            assert!(!quit_key(key, ctrl, alt, shift));
        }
    }
}

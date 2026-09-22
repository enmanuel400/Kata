use std::fs;
use tauri::{Emitter, Manager};
use url::Url;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Crea un webview hijo (pestaña) dentro de la ventana principal.
/// Al crearse desde Rust podemos enganchar callbacks de navegación que
/// notifican al frontend la URL real visitada (evento `kata://navigation`).
/// La posición y el tamaño llegan ya en **píxeles físicos** para evitar
/// errores de conversión logical↔physical en el renderizado del webview.
#[tauri::command]
fn create_tab_webview(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "ventana principal no encontrada".to_string())?;
    let parsed = Url::parse(&url).map_err(|err| err.to_string())?;

    let nav_app = app.clone();
    let nav_label = label.clone();
    let load_app = app.clone();
    let load_label = label.clone();
    let title_app = app.clone();
    let title_label = label.clone();

    let builder = tauri::WebviewBuilder::new(label, tauri::WebviewUrl::External(parsed))
        .zoom_hotkeys_enabled(true)
        .on_navigation(move |nav_url| {
            let _ = nav_app.emit_to(
                "main",
                "kata://navigation",
                (nav_label.clone(), nav_url.to_string()),
            );
            true
        })
        .on_page_load(move |_webview, payload| {
            let _ = load_app.emit_to(
                "main",
                "kata://navigation",
                (load_label.clone(), payload.url().to_string()),
            );
        })
        // Título real de la página. `connect_title_notify` de WebKit lo emite
        // en cada cambio del `<title>` (también en SPAs como YouTube, que lo
        // cambian por JS sin recargar). Así la pestaña muestra el título del
        // contenido y no el dominio con el que se abrió.
        .on_document_title_changed(move |_webview, title| {
            let t = title.trim().to_string();
            if !t.is_empty() {
                let _ = title_app.emit_to("main", "kata://title", (title_label.clone(), t));
            }
        });

    window
        .add_child(
            builder,
            tauri::PhysicalPosition::new(x, y),
            tauri::PhysicalSize::new(width, height),
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// Navega un webview a una nueva URL sin recrearlo (conserva historial y estado).
#[tauri::command]
fn navigate_webview(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview no encontrado: {label}"))?;
    let parsed = Url::parse(&url).map_err(|err| err.to_string())?;
    webview.navigate(parsed).map_err(|err| err.to_string())
}

/// Devuelve la URL actual real del webview (el proceso UI pregunta a WebKit).
/// El frontend la usa como red de seguridad para reflejar la URL en la barra
/// en navegaciones SPA (pushState/hash) que no emiten `kata://navigation`.
#[tauri::command]
fn webview_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview no encontrado: {label}"))?;
    let u = webview.url().map_err(|err| err.to_string())?;
    Ok(u.to_string())
}

/// Guarda el estado completo de la app (espacios, pestañas, historial y
/// favoritos) en `kata-state.json` dentro del directorio de configuración.
/// Escritura atómica: primero a un temporal y luego rename, para no corromper
/// el archivo si el proceso muere a mitad de escritura.
#[tauri::command]
fn save_state(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let final_path = dir.join("kata-state.json");
    let tmp_path = dir.join("kata-state.json.tmp");
    fs::write(&tmp_path, contents).map_err(|err| err.to_string())?;
    fs::rename(&tmp_path, &final_path).map_err(|err| err.to_string())?;
    Ok(())
}

/// Carga el estado persistido. Devuelve error si todavía no existe
/// (primer arranque): el frontend usa entonces el estado semilla.
#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?;
    let path = dir.join("kata-state.json");
    fs::read_to_string(path).map_err(|err| err.to_string())
}

/// Guarda la imagen de fondo del Inicio (data URL) en un archivo aparte del
/// JSON de estado, para que los autoguardados no reescriban megabytes.
#[tauri::command]
fn save_wallpaper(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let final_path = dir.join("wallpaper.data");
    let tmp_path = dir.join("wallpaper.data.tmp");
    fs::write(&tmp_path, contents).map_err(|err| err.to_string())?;
    fs::rename(&tmp_path, &final_path).map_err(|err| err.to_string())?;
    Ok(())
}

/// Elimina la imagen de fondo guardada.
#[tauri::command]
fn clear_wallpaper(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?;
    let path = dir.join("wallpaper.data");
    if path.exists() {
        fs::remove_file(&path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Devuelve la imagen de fondo guardada (data URL) o vacío si no hay.
#[tauri::command]
fn load_wallpaper(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?;
    let path = dir.join("wallpaper.data");
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|err| err.to_string())
}

/// Ejecuta una acción de navegación simple (atrás, adelante o recargar)
/// dentro del webview indicado.
#[tauri::command]
fn webview_action(app: tauri::AppHandle, label: String, action: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview no encontrado: {label}"))?;
    match action.as_str() {
        "back" => webview.eval("history.back()").map_err(|err| err.to_string()),
        "forward" => webview.eval("history.forward()").map_err(|err| err.to_string()),
        // recarga nativa (proceso UI): funciona aunque el WebProcess haya caído,
        // cosa que `location.reload()` vía eval no puede hacer
        "reload" => webview.reload().map_err(|err| err.to_string()),
        _ => Err(format!("acción no soportada: {action}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            create_tab_webview,
            navigate_webview,
            webview_url,
            webview_action,
            save_state,
            load_state,
            save_wallpaper,
            clear_wallpaper,
            load_wallpaper
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
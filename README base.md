# kata

> Un navegador web local, privado y silencioso hecho con Tauri 2 y React 19.
> A local, private and quiet web browser built with Tauri 2 and React 19.

**Español** · [**English**](#english)

---

## Español

kata es un navegador de escritorio para Linux que pone tus datos en primer
lugar: **todo vive en tu dispositivo**. Sin cuentas, sin telemetría, sin
sincronización forzada. Espacios con pestañas, suspensión de procesos para
ahorrar memoria, temas de interfaz, widgets en el Inicio y un perfil local.

Pila tecnológica: **Tauri 2** (Rust) + **React 19** + **TypeScript** + **Vite**.
Cada pestaña es un WebView nativo (WebKitGTK) superpuesto en tiempo real sobre
la interfaz; Rust conecta los callbacks de navegación y de título con el
frontend.

### Requisitos

- Node.js 18+ y npm
- Rust (toolchain estable)
- Dependencias de Tauri 2 en Linux (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Desarrollo

```bash
npm install
npm run tauri dev        # lanza Vite (:1420) y el binario de depuración
```

- Los cambios de **frontend** se aplican en caliente a través de Vite.
- Los cambios de **Rust** requieren recompilar:

```bash
cd src-tauri && cargo build
```

- El binario de depuración se genera en `src-tauri/target/debug/kata`.

### Empaquetado

```bash
npm run tauri build
```

Genera los bundles de instalación en `src-tauri/target/release/bundle/`
(deb, rpm, AppImage, etc.) con el identificador `com.demon0.kata`.

### Características

#### Pestañas
- **Nueva pestaña** (`+`, `Ctrl+T`) · **cerrarla** (`×`, clic central, `Ctrl+W`).
- **Reabrir la última cerrada** con `Ctrl+Shift+T` (vuelve a su espacio).
- Selección con `Ctrl+1…9` y alternancia con `Ctrl+Tab` / `Ctrl+Shift+Tab`.
- **Título real de la página**: la pestaña muestra el `<title>` del contenido
  (también en SPAs como YouTube, que lo cambian sin recargar), no el dominio
  con el que se abrió. Llega por el evento `kata://title` (Signal de WebKit).

#### Espacios (workspaces)
- Crear, renombrar y cerrar espacios desde la barra lateral.
- **Popover «ver pestañas»** (◫): salta directamente a la pestaña que quieras
  de un espacio.
- **Espacio privado**: con el candado 🔒 no registra historial.

#### Barra de direcciones
- URLs directas (`dominio.com`, `localhost`, IPs) y **búsqueda por motor**
  configurable (Google, DuckDuckGo, Bing).
- **Sugerencias desplegables** al escribir: búsqueda + coincidencias de
  historial y favoritos. Navegación con `↑`/`↓`, `Enter`, `Escape`.

#### Navegación y zoom
- **Atrás / Adelante / Recargar** (`Alt+←`, `Alt+→`, `Ctrl+R`).
- Zoom por sitio con `Ctrl+±` / `Ctrl+0` dentro de cada página (WebKit).
- La recarga es **nativa** (proceso UI): funciona incluso si el WebProcess de
  la página se cayó (p. ej. crash de GStreamer en vídeo).

#### Suspensión por inactividad
- Libera el proceso de las pestañas ocultas tras un respiro (30 s, 1 min o
  2 min) para ahorrar memoria; se reactivan solas al entrar.
- **Dominios exentos** (`youtube.com` y subdominios) que nunca se suspenden.
  Se puede desactivar por completo.

#### Inicio
- Saludo con **tu nombre** (clic sobre él para cambiarlo en sitio).
- **Reloj** en tiempo real y **fecha** con semana ISO.
- **Accesos rápidos** (historial reciente), **notas** persistentes con
  autoguardado y **favoritos**.
- **Fondo con imagen** propia, persistente entre sesiones y con velo oscuro
  para mantener el texto legible.

#### Historial y favoritos
- Historial local con tope de 300 entradas, títulos reales y borrado con
  confirmación (`Borrar historial`).
- Favoritos guardados con `Ctrl+D` o el botón ★, con su propia vista.
- `Ctrl+clic` sobre una entrada la abre en una pestaña nueva.

#### Temas
- Cinco temas persistidos: **oscuro** (negro neutro), **claro**, **noche**,
  **mocha** y **nord**, aplicados al instante vía `data-theme`.

#### Perfil local
- **Chip de perfil** en la barra lateral con avatar (inicial), nombre editable
  y menú: cambiar nombre, Preferencias y **exportar el estado (JSON) al
  portapapeles**.
- El nombre también se edita clicando en el saludo del Inicio.

#### Conmutador rápido
- `Ctrl+P`: busca y salta entre **pestañas y espacios** escribiendo; las
  pestañas de espacios privados muestran 🔒.

#### Pase de bienvenida (primer arranque)
- Al abrir por primera vez, una vista guía la configuración de **nombre**,
  **tema preferido** y **fondo de inicio**, y muestra **tus contactos**
  (de momento son de ejemplo; la lista real llegará en una próxima versión).

#### Preferencias
- **Rendimiento**: suspensión, respiro y dominios exentos.
- **General**: comportamiento al iniciar, buscador, nombre, tema y fondo.
- **Datos**: borrar historial y favoritos.
- **Sobre el creador**: ficha del autor y sus enlaces (provisionales).

### Atajos de teclado

| Atajo | Acción |
| --- | --- |
| `Ctrl+T` | Nueva pestaña |
| `Ctrl+W` | Cerrar pestaña activa |
| `Ctrl+Shift+T` | Reabrir la última pestaña cerrada |
| `Ctrl+1…9` | Saltar a la pestaña N del espacio activo |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Pestaña siguiente / anterior |
| `Ctrl+L` | Enfocar la barra de direcciones |
| `Ctrl+R` | Recargar página |
| `Ctrl+D` | Guardar / quitar favorito |
| `Ctrl+P` | Conmutador rápido (pestañas y espacios) |
| `Alt+←` / `Alt+→` | Atrás / adelante |
| `Ctrl+±` / `Ctrl+0` | Zoom dentro de las páginas |
| Clic central en pestaña | Cerrarla |
| `Ctrl+clic` en una entrada | Abrir en pestaña nueva |
| `Escape` | Cerrar menús, popovers y sugerencias |

### Persistencia y privacidad

- El estado se guarda en `~/.config/com.demon0.kata/kata-state.json` con
  **escritura atómica** (tmp + rename), **debounce de 500 ms**, **flush al
  cerrar** la ventana y **salto de escrituras idénticas** (A3).
- El fondo del Inicio vive en un **archivo aparte** (`wallpaper.data`) para que
  los autoguardados no reescriban megabytes (A1); si migras desde versiones
  antiguas, se mueve solo y se limpia del JSON.
- El historial tiene tope (A2), los espacios privados no registran nada y no
  existe telemetría: **tus datos no salen de tu máquina**.

### Arquitectura técnica

- **Rust (`src-tauri/src/lib.rs`)** — comandos:
  `create_tab_webview`, `navigate_webview`, `webview_url`, `webview_action`,
  `save_state` / `load_state`, `save_wallpaper` / `clear_wallpaper` /
  `load_wallpaper`.
- **Eventos cromo ↔ Rust**: `kata://navigation` (URL real navegada) y
  `kata://title` (título real de la página).
- **Parches vendored** para Linux/Wayland:
  - `tauri-runtime-wry` — `GtkFixed` compartido que hace de contenido de la
    ventana y fija el `size_request`, de modo que `set_bounds` de cada pestaña
    se aplica de verdad y las páginas altas no agrandan la ventana.
  - `wry` — `set_bounds`/`bounds` reales y `zoom_hotkeys` para las páginas.
- **Oclusión de overlays**: los WebViews nativos se pintan *por encima* del
  HTML del cromo. Cuando un overlay del cromo los cubriría (sugerencias de la
  barra o conmutador `Ctrl+P`), los WebViews se mueven temporalmente fuera de
  pantalla (sin cerrarse) y se restauran al cerrar el overlay.

### Estructura del proyecto

```
kata/
├── src/
│   ├── App.tsx          # Frontend completo (estado, pestañas, vistas, atajos)
│   └── App.css          # Temas (:root[data-theme=…]) y estilos
├── src-tauri/
│   ├── src/lib.rs       # Comandos Rust y callbacks de navegación/título
│   ├── capabilities/default.json
│   ├── tauri.conf.json  # Configuración e identificador (com.demon0.kata)
│   └── vendor/          # Parches de tauri-runtime-wry y wry
└── package.json
```

### Estado del proyecto

Completado: A1 (fondo fuera del JSON), A2 (tope de historial), A3 (guardado
deduplicado), B1 (sugerencias), B2 (conmutador rápido), B3 (espacio privado)
y el título real de páginas.

En el roadmap: mover pestañas entre espacios, pestañas ancladas, página de
error, favicons, historial agrupado por día, zoom por sitio (persistido),
pantalla completa (`F11`), limpiar cookies/caché, importar favoritos, barra
de estado, speed dial editable, bandera de DevTools y la **lista real de
contactos**.

### Licencia

Por definir. Mientras tanto, uso personal y educativo.

---

<a name="english"></a>

## English

kata is a desktop browser for Linux that puts your data first: **everything
lives on your device**. No accounts, no telemetry, no forced sync. Workspaces
with tabs, process suspension to save memory, interface themes, Home widgets
and a local profile.

Tech stack: **Tauri 2** (Rust) + **React 19** + **TypeScript** + **Vite**.
Each tab is a native WebView (WebKitGTK) composited in real time over the UI;
Rust wires navigation and title callbacks to the frontend.

### Requirements

- Node.js 18+ and npm
- Rust (stable toolchain)
- Tauri 2 Linux dependencies (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Development

```bash
npm install
npm run tauri dev        # starts Vite (:1420) and the debug binary
```

- **Frontend** changes are hot-reloaded through Vite.
- **Rust** changes require a rebuild:

```bash
cd src-tauri && cargo build
```

- The debug binary is generated at `src-tauri/target/debug/kata`.

### Packaging

```bash
npm run tauri build
```

Builds installers under `src-tauri/target/release/bundle/` (deb, rpm,
AppImage, etc.) with the identifier `com.demon0.kata`.

### Features

#### Tabs
- **New tab** (`+`, `Ctrl+T`) · **close** (`×`, middle-click, `Ctrl+W`).
- **Reopen last closed** with `Ctrl+Shift+T` (restores its workspace).
- Select with `Ctrl+1…9`, alternate with `Ctrl+Tab` / `Ctrl+Shift+Tab`.
- **Real page title**: the tab shows the content's `<title>` (including SPAs
  such as YouTube, which change it without reloading), not the domain it was
  opened with. Delivered by the `kata://title` WebKit signal.

#### Workspaces
- Create, rename and close workspaces from the sidebar.
- **"See tabs" popover** (◫): jump straight to any tab of a workspace.
- **Private workspace**: with the 🔒 lock it records no history.

#### Address bar
- Direct URLs (`domain.com`, `localhost`, IPs) and **configurable search
  engine** (Google, DuckDuckGo, Bing).
- **Dropdown suggestions** while typing: search + history and favorites
  matches. Navigation with `↑`/`↓`, `Enter`, `Escape`.

#### Navigation and zoom
- **Back / Forward / Reload** (`Alt+←`, `Alt+→`, `Ctrl+R`).
- Per-site zoom with `Ctrl+±` / `Ctrl+0` inside pages (WebKit).
- Reload is **native** (UI process): it works even if a page's WebProcess
  crashed (e.g. a GStreamer crash in video).

#### Suspend by inactivity
- Frees the process of hidden tabs after a grace period (30 s, 1 min or
  2 min) to save memory; they wake up automatically when re-entered.
- **Exempt domains** (`youtube.com` and subdomains) never suspend. Can be
  turned off completely.

#### Home
- Greeting with **your name** (click it to change it in place).
- Real-time **clock** and **date** with ISO week number.
- **Quick access** (recent history), persistent **notes** with autosave and
  **favorites**.
- Custom **wallpaper**, persistent across sessions, with a dark veil so text
  stays readable.

#### History and favorites
- Local history capped at 300 entries, real titles and confirmed clearing.
- Favorites saved with `Ctrl+D` or the ★ button, with their own view.
- `Ctrl+click` an entry to open it in a new tab.

#### Themes
- Five persisted themes: **dark** (neutral black), **light**, **night**,
  **mocha** and **nord**, applied instantly through `data-theme`.

#### Local profile
- **Profile chip** in the sidebar with avatar, editable name and a menu:
  change name, Preferences and **export the state (JSON) to the clipboard**.
- The name is also editable by clicking the Home greeting.

#### Quick switcher
- `Ctrl+P`: find and jump between **tabs and workspaces** by typing; tabs in
  private workspaces show 🔒.

#### First-run welcome
- On first launch, a walkthrough sets up your **name**, **preferred theme**
  and **home wallpaper**, and shows **your contacts** (examples for now; the
  real list ships in an upcoming version).

#### Settings
- **Performance**: suspension, grace period and exempt domains.
- **General**: startup behavior, search engine, name, theme and wallpaper.
- **Data**: clear history and favorites.
- **About the creator**: author info and links (provisional).

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close active tab |
| `Ctrl+Shift+T` | Reopen last closed tab |
| `Ctrl+1…9` | Jump to tab N of the active workspace |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+L` | Focus the address bar |
| `Ctrl+R` | Reload page |
| `Ctrl+D` | Toggle favorite |
| `Ctrl+P` | Quick switcher (tabs and workspaces) |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl+±` / `Ctrl+0` | Zoom inside pages |
| Middle-click on a tab | Close it |
| `Ctrl+click` an entry | Open in a new tab |
| `Escape` | Close menus, popovers and suggestions |

### Persistence and privacy

- State is saved to `~/.config/com.demon0.kata/kata-state.json` with **atomic
  writes** (tmp + rename), **500 ms debounce**, a **flush on window close**
  and **identical-write skipping** (A3).
- The Home wallpaper lives in a **separate file** (`wallpaper.data`) so saves
  never rewrite megabytes (A1); if you migrate from older versions it is
  moved automatically and removed from the JSON.
- History is capped (A2), private workspaces record nothing and there is no
  telemetry: **your data never leaves your machine**.

### Technical architecture

- **Rust (`src-tauri/src/lib.rs`)** — commands:
  `create_tab_webview`, `navigate_webview`, `webview_url`, `webview_action`,
  `save_state` / `load_state`, `save_wallpaper` / `clear_wallpaper` /
  `load_wallpaper`.
- **Chrome ↔ Rust events**: `kata://navigation` (real navigated URL) and
  `kata://title` (real page title).
- **Vendored patches** for Linux/Wayland:
  - `tauri-runtime-wry` — a shared `GtkFixed` as window content with a pinned
    `size_request`, so each tab's `set_bounds` actually applies and tall pages
    cannot grow the window.
  - `wry` — real `set_bounds`/`bounds` and `zoom_hotkeys` for pages.
- **Overlay occlusion**: native WebViews paint *above* the chrome HTML. When a
  chrome overlay would be covered (address suggestions or the `Ctrl+P`
  switcher), WebViews are temporarily moved off-screen (without closing) and
  restored when the overlay closes.

### Project structure

```
kata/
├── src/
│   ├── App.tsx          # Full frontend (state, tabs, views, shortcuts)
│   └── App.css          # Themes (:root[data-theme=…]) and styles
├── src-tauri/
│   ├── src/lib.rs       # Rust commands and navigation/title callbacks
│   ├── capabilities/default.json
│   ├── tauri.conf.json  # Config and identifier (com.demon0.kata)
│   └── vendor/          # tauri-runtime-wry and wry patches
└── package.json
```

### Project status

Done: A1 (wallpaper out of the JSON), A2 (history cap), A3 (deduplicated
saves), B1 (address suggestions), B2 (quick switcher), B3 (private workspace)
and real page titles.

Roadmap: move tabs between workspaces, pinned tabs, error page, favicons,
history grouped by day, per-site zoom (persisted), fullscreen (`F11`), clear
cookies/cache, import favorites, status bar, editable speed dial, a DevTools
flag and the **real contacts list**.

### License

To be defined. Personal and educational use for now.

---

Hecho con Tauri 2 · React 19 · Rust — Privacidad primero / Made with Tauri 2 ·
React 19 · Rust — Privacy first.
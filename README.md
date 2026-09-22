<div align="center">

# kata

### Un navegador de escritorio local, privado y silencioso para Linux

<p>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111827" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-6-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Rust-1.85+-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/Linux-supported-FCC624?style=for-the-badge&logo=linux&logoColor=111827" alt="Linux">
</p>

<p>
  <a href="#características">Características</a> ·
  <a href="#instalación-y-desarrollo">Instalación</a> ·
  <a href="#privacidad">Privacidad</a> ·
  <a href="#atajos-de-teclado">Atajos</a>
</p>

</div>

---

## Sobre kata

kata es un navegador de escritorio construido para mantener una experiencia
simple y tus datos cerca de ti. No necesita cuentas, no incluye telemetría ni
fuerza sincronización con la nube: el estado de la aplicación se guarda
localmente en tu equipo.

La interfaz está hecha con React y cada pestaña se renderiza como un WebView
nativo administrado por Tauri. El resultado es una aplicación ligera, con
espacios de trabajo, herramientas de organización y una página de inicio
personalizable.

## Capturas

<div align="center">
  <img src="assets/screenshots/kata-home.png" alt="Página de inicio de kata" width="49%">
  <img src="assets/screenshots/kata-search.png" alt="Búsqueda web desde kata" width="49%">
  <img src="assets/screenshots/kata-youtube.png" alt="YouTube ejecutándose en kata" width="49%">
</div>

## Características

### Navegación

- Pestañas nativas con títulos reales de las páginas.
- Barra de direcciones con URLs directas y búsquedas.
- Motores configurables: Google, DuckDuckGo y Bing.
- Sugerencias de historial y favoritos mientras escribes.
- Atrás, adelante, recarga nativa y zoom por página.
- Suspensión de pestañas inactivas para reducir el uso de memoria.

### Organización

- Espacios de trabajo para separar contextos.
- Espacio privado que no registra historial.
- Historial local con límite de 300 entradas.
- Favoritos guardados en el dispositivo.
- Conmutador rápido (`Ctrl+P`) para encontrar pestañas y espacios.

### Página de inicio

- Reloj y fecha en tiempo real.
- Accesos rápidos a páginas recientes.
- Notas persistentes con autoguardado.
- Fondo de inicio personalizado.
- Cinco temas: oscuro, claro, noche, mocha y nord.

## Stack tecnológico

<div align="center">

| Capa                     | Tecnología                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aplicación de escritorio | <img src="https://cdn.simpleicons.org/tauri/24C8DB" width="18" alt="Tauri"> **Tauri 2**                                                                                                         |
| Backend nativo           | <img src="https://cdn.simpleicons.org/rust/000000" width="18" alt="Rust"> **Rust**                                                                                                              |
| Interfaz                 | <img src="https://cdn.simpleicons.org/react/61DAFB" width="18" alt="React"> **React 19** + <img src="https://cdn.simpleicons.org/typescript/3178C6" width="18" alt="TypeScript"> **TypeScript** |
| Tooling                  | <img src="https://cdn.simpleicons.org/vite/646CFF" width="18" alt="Vite"> **Vite**                                                                                                              |
| Renderizado web          | **WebKitGTK** mediante Wry                                                                                                                                                                      |

</div>

El proyecto incluye parches locales de `tauri-runtime-wry` y `wry` para mejorar
el posicionamiento y el tamaño de los WebViews en Linux/Wayland.

## Instalación y desarrollo

### Requisitos

- Linux.
- [Node.js](https://nodejs.org/) 18 o superior y npm.
- [Rust](https://www.rust-lang.org/tools/install) estable y Cargo.
- Dependencias de Tauri 2.

En Debian o Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Ejecutar en modo desarrollo

```bash
git clone https://github.com/enmanuel400/Kata.git
cd Kata
npm install
npm run tauri dev
```

Vite recarga automáticamente los cambios del frontend. Los cambios en Rust
requieren recompilar la aplicación.

### Crear una compilación

```bash
npm run build
npm run tauri build
```

Los instaladores se generan en
`src-tauri/target/release/bundle/` (AppImage, DEB, RPM, entre otros).

## Privacidad

kata sigue un modelo local:

- No requiere cuentas ni sincronización.
- No incorpora telemetría.
- El estado se guarda en
  `~/.config/com.demon0.kata/kata-state.json`.
- El fondo se guarda por separado para evitar reescrituras innecesarias.
- Los espacios privados no agregan páginas al historial.
- El guardado usa escritura atómica para reducir el riesgo de corrupción.

## Atajos de teclado

| Atajo                         | Acción                             |
| ----------------------------- | ---------------------------------- |
| `Ctrl+T`                      | Nueva pestaña                      |
| `Ctrl+W`                      | Cerrar la pestaña activa           |
| `Ctrl+Shift+T`                | Reabrir la última pestaña cerrada  |
| `Ctrl+L`                      | Enfocar la barra de direcciones    |
| `Ctrl+R`                      | Recargar la página                 |
| `Ctrl+D`                      | Guardar o quitar favorito          |
| `Ctrl+P`                      | Abrir el conmutador rápido         |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cambiar de pestaña                 |
| `Alt+←` / `Alt+→`             | Atrás / adelante                   |
| `Ctrl+±` / `Ctrl+0`           | Acercar, alejar o restablecer zoom |
| Clic central en una pestaña   | Cerrar la pestaña                  |

## Estructura del proyecto

```text
src/                 # Interfaz React, estado y estilos
src-tauri/src/       # Comandos Rust y gestión de WebViews
src-tauri/vendor/    # Parches locales para Wry y Tauri Runtime
assets/screenshots/  # Capturas de la documentación
```

## Estado del proyecto

kata está en desarrollo activo. El roadmap incluye pestañas ancladas,
favicons, historial agrupado, importación de favoritos y gestión de cookies y
caché.

---

<div align="center">

Hecho con Tauri, Rust, React y TypeScript.

</div>

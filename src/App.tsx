import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Webview, getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

type Tab = { id: number; title: string; domain: string; url: string; tone: string };
type Space = { id: number; name: string; tone: string; activeTabId: number; tabs: Tab[]; priv: boolean };
type HistoryEntry = { id: number; url: string; title: string; visitedAt: number };
type Favorite = { id: number; url: string; title: string; domain: string; addedAt: number };
type View = "tab" | "home" | "history" | "favorites" | "settings" | "welcome";
type Suggestion = { kind: "buscar" | "historial" | "favorito"; url: string; title: string; sub: string };
type SwitcherItem =
    | { type: "space"; spaceId: number; name: string; tabs: number }
    | { type: "tab"; spaceId: number; spaceName: string; tabId: number; title: string; url: string; priv: boolean };
type ThemeName = "oscuro" | "claro" | "noche" | "mocha" | "nord";
type Settings = {
    suspendEnabled: boolean;
    suspendExemptDomains: string[];
    suspendAfterMs: number;
    searchEngine: "google" | "duckduckgo" | "bing";
    startRestoreTabs: boolean;
    theme: ThemeName;
    userName: string; // nombre mostrado en el saludo del Inicio; "" = sin nombre
    onboarded: boolean; // primer arranque completado (pase de bienvenida)
};
type PersistedState = {
    version: number;
    activeSpaceId: number;
    spaces: Space[];
    history: HistoryEntry[];
    favorites: Favorite[];
    sidebarOpen: boolean;
    settings?: Settings;
    note?: string;
};
type WebviewEntry = { wv: Webview; ready: Promise<void> };

const DEBUG = import.meta.env.DEV;

// Ids monotónicos: nunca colisionan con los ids restaurados de sesiones previas.
let uid = Date.now();
const nextId = () => ++uid;

const HISTORY_CAP = 300;
const SUSPEND_AFTER_MS = 45_000;   // respiro antes de liberar el proceso de una pestaña oculta
const SUSPEND_SWEEP_MS = 10_000;   // frecuencia del barrido de suspensión

const TAB_TONES = ["blue", "cream", "green"];
const toneFor = (id: number) => TAB_TONES[id % TAB_TONES.length];

const defaultSettings: Settings = {
    suspendEnabled: true,
    suspendExemptDomains: [],
    suspendAfterMs: SUSPEND_AFTER_MS,
    searchEngine: "google",
    startRestoreTabs: true,
    theme: "oscuro",
    userName: "",
    onboarded: false,
};

const THEMES: Array<{ id: ThemeName; name: string }> = [
    { id: "oscuro", name: "Oscuro" },
    { id: "claro", name: "Claro" },
    { id: "noche", name: "Noche" },
    { id: "mocha", name: "Mocha" },
    { id: "nord", name: "Nord" },
];

const SEARCH_URLS: Record<Settings["searchEngine"], (q: string) => string> = {
    google: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    duckduckgo: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    bing: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

const SEARCH_NAMES: Record<Settings["searchEngine"], string> = {
    google: "Google",
    duckduckgo: "DuckDuckGo",
    bing: "Bing",
};

// Canales de contacto del creador, mostrados en la bienvenida y en
// Preferencias (datos reales). kind: "link" abre en una pestaña nueva,
// "copy" copia el valor al portapapeles (correo y teléfono no son páginas).
type Contact = { id: number; icon: string; label: string; value: string; kind: "link" | "copy"; tone: "ember" | "gold" | "sage" | "slate" };
const CONTACTS: Contact[] = [
    { id: 1, icon: "✉", label: "Correo", value: "enmanuelpirela400@gmail.com", kind: "copy", tone: "gold" },
    { id: 2, icon: "LI", label: "LinkedIn", value: "linkedin.com/in/enmanuel-pirela-697020437", kind: "link", tone: "sage" },
    { id: 3, icon: "GH", label: "GitHub", value: "github.com/enmanuel400", kind: "link", tone: "ember" },
    { id: 4, icon: "✆", label: "Teléfono", value: "+58 424 658 5219", kind: "copy", tone: "slate" },
];

// Ficha del creador (sección «Sobre el creador» en Preferencias), con los
// datos reales del desarrollador.
type CreatorLink = { label: string; value: string; kind: "link" | "copy" };
const CREATOR: { name: string; handle: string; role: string; bio: string; links: CreatorLink[] } = {
    name: "Enmanuel Pirela",
    handle: "@enmanuel400",
    role: "Desarrollador independiente de software libre",
    bio: "Creo herramientas de escritorio ligeras y locales. Kata nace de la idea de un navegador que respeta tu privacidad y tu máquina: todo vive en tu dispositivo, sin cuentas ni telemetría.",
    links: [
        { label: "GitHub", value: "github.com/enmanuel400", kind: "link" },
        { label: "LinkedIn", value: "linkedin.com/in/enmanuel-pirela-697020437", kind: "link" },
        { label: "Correo", value: "enmanuelpirela400@gmail.com", kind: "copy" },
        { label: "Teléfono", value: "+58 424 658 5219", kind: "copy" },
    ],
};

// ¿Es una URL o algo buscable? Dominios con punto, localhost e IP van
// directos a https; palabras sueltas o frases se buscan en el motor elegido.
function looksLikeUrl(raw: string): boolean {
    if (raw.includes("://")) return true;
    if (/^localhost(:\d+)?(\/|$)/.test(raw)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)) return true;
    return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw);
}

// Un dominio exento coincide exactamente o por sufijo (subdominios).
function isExemptUrl(url: string, list: string[]): boolean {
    if (!url || list.length === 0) return false;
    const host = hostOf(url).toLowerCase();
    return list.some(entry => {
        const e = entry.trim().toLowerCase().replace(/^www\./, "");
        if (!e) return false;
        return host === e || host.endsWith(`.${e}`);
    });
}

function hostOf(raw: string): string {
    try {
        return new URL(raw).hostname.replace(/^www\./, "");
    } catch {
        return raw.replace(/^https?:\/\//, "").split("/")[0] || raw;
    }
}

function fmtWhen(ts: number): string {
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return "ahora";
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = new Date(ts);
    const dd = `${d.getDate()}`.padStart(2, "0");
    const mm = `${d.getMonth() + 1}`.padStart(2, "0");
    return `${dd}/${mm}`;
}

// Número de semana ISO-8601 para la tarjeta de fecha del inicio.
function isoWeek(d: Date): number {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// Estado semilla del primer arranque: un solo espacio vacío (bienvenida).
function defaultState(): PersistedState {
    const spaceId = nextId();
    return {
        version: 1,
        activeSpaceId: spaceId,
        spaces: [
            { id: spaceId, name: "Personal", tone: "orange", activeTabId: 0, tabs: [], priv: false },
        ],
        history: [],
        favorites: [],
        sidebarOpen: true,
        settings: defaultSettings,
    };
}

function App() {
    const [spaces, setSpaces] = useState<Space[]>([]);
    const [activeSpaceId, setActiveSpaceId] = useState(0);
    const [view, setView] = useState<View>("home");
    const [address, setAddress] = useState("");
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [favorites, setFavorites] = useState<Favorite[]>([]);
    const [loading, setLoading] = useState(false);
    const [booted, setBooted] = useState(false);
    const [renamingId, setRenamingId] = useState<number | null>(null);
    const [renamingName, setRenamingName] = useState("");
    const [menuId, setMenuId] = useState<number | null>(null);
    const [confirmingId, setConfirmingId] = useState<number | null>(null);
    const [settings, setSettings] = useState<Settings>(defaultSettings);
    const [exemptInput, setExemptInput] = useState("");
    const [confirmClear, setConfirmClear] = useState<"history" | "favorites" | null>(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const [contactCopied, setContactCopied] = useState<string | null>(null); // feedback «¡Copiado!»
    const [tabsMenuFor, setTabsMenuFor] = useState<number | null>(null);
    const [tabsMenuPos, setTabsMenuPos] = useState<{ x: number; y: number } | null>(null);
    const [menuPos, setMenuPos] = useState<{ right: number; top: number } | null>(null);
    const [note, setNote] = useState("");
    const [wallpaperMsg, setWallpaperMsg] = useState("");
    const [wallpaper, setWallpaper] = useState(""); // data URL del fondo del Inicio (guardada en archivo aparte)

    // Sugerencias de la barra de direcciones (B1).
    const [suggestOpen, setSuggestOpen] = useState(false);
    const [suggestIdx, setSuggestIdx] = useState(0);
    const suggestTouchedRef = useRef(false); // ¿el usuario movió el cursor con las flechas?

    // Conmutador rápido de pestañas/espacios (B2, Ctrl+P).
    const [switcherOpen, setSwitcherOpen] = useState(false);
    const [switcherQuery, setSwitcherQuery] = useState("");
    const [switcherIdx, setSwitcherIdx] = useState(0);
    const switcherInputRef = useRef<HTMLInputElement | null>(null);

    // ---- Sugerencias de la barra de direcciones (B1) -----------------------

    const suggestions = useMemo<Suggestion[]>(() => {
        if (!suggestOpen) return [];
        const q = address.trim().toLowerCase();
        if (!q) return [];
        const seen = new Set<string>();
        const out: Suggestion[] = [];
        const push = (kind: Suggestion["kind"], url: string, title: string, sub: string) => {
            if (seen.has(url)) return;
            seen.add(url);
            out.push({ kind, url, title, sub });
        };
        for (const h of history) {
            if (out.length >= 7) break;
            if (
                h.url.toLowerCase().includes(q) ||
                h.title.toLowerCase().includes(q) ||
                hostOf(h.url).includes(q)
            ) push("historial", h.url, h.title, hostOf(h.url));
        }
        for (const f of favorites) {
            if (out.length >= 7) break;
            if (f.url.toLowerCase().includes(q) || f.title.toLowerCase().includes(q))
                push("favorito", f.url, f.title, f.domain);
        }
        const engine = SEARCH_NAMES[settings.searchEngine];
        out.unshift({ kind: "buscar", url: SEARCH_URLS[settings.searchEngine](q), title: `Buscar “${address.trim()}”`, sub: engine });
        return out.slice(0, 8);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [suggestOpen, address, history, favorites, settings.searchEngine]);

    // Candidatos del conmutador rápido (espacios y pestañas, filtrados).
    const switcherItems = useMemo<SwitcherItem[]>(() => {
        const q = switcherQuery.trim().toLowerCase();
        const items: SwitcherItem[] = [];
        for (const s of spaces) {
            const spaceMatch = !q || s.name.toLowerCase().includes(q);
            if (spaceMatch) items.push({ type: "space", spaceId: s.id, name: s.name, tabs: s.tabs.length });
            for (const t of s.tabs) {
                if (!spaceMatch && !q) continue;
                if (!q || (t.title + " " + t.url).toLowerCase().includes(q))
                    items.push({ type: "tab", spaceId: s.id, spaceName: s.name, tabId: t.id, title: t.title, url: t.url, priv: s.priv });
            }
        }
        return items;
    }, [switcherQuery, spaces]);
    const [nowTick, setNowTick] = useState(() => new Date());
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState("");
    const [profileOpen, setProfileOpen] = useState(false);
    const [profilePos, setProfilePos] = useState<{ left: number; bottom: number } | null>(null);
    const [editingProfileName, setEditingProfileName] = useState(false);
    const [profileNameDraft, setProfileNameDraft] = useState("");
    const [profileMsg, setProfileMsg] = useState("");

    const webviews = useRef(new Map<number, WebviewEntry>());
    const creating = useRef(new Map<number, Promise<WebviewEntry | null>>());
    const hostRef = useRef<HTMLDivElement | null>(null);
    const addressRef = useRef<HTMLInputElement | null>(null);
    // Los overlays (sugerencias y conmutador) se dibujan en el cromo HTML,
    // pero los webviews de pestaña son widgets GTK que se pintan POR ENCIMA
    // del cromo. Mientras un overlay está abierto, ocultamos los webviews
    // (bounds fuera de pantalla) y los restauramos al cerrar.
    const occludeRef = useRef(false);
    const occludedBoundsRef = useRef(new Map<number, { x: number; y: number; width: number; height: number }>());
    // Estado de edición explícito de la barra. NO se puede derivar de
    // `document.activeElement`: cuando el usuario hace clic dentro del contenido
    // (un webview nativo distinto), el documento principal no pierde el foco del
    // input y el guard quedaría activo para siempre, bloqueando la URL real.
    const typingRef = useRef(false);
    const activeTabRef = useRef(0);
    const activeSpaceIdRef = useRef(0);
    const spacesRef = useRef<Space[]>([]);
    const viewRef = useRef<View>("home");
    const sidebarOpenRef = useRef(true);
    const historyRef = useRef<HistoryEntry[]>([]);
    const favoritesRef = useRef<Favorite[]>([]);
    const lastActivatedRef = useRef(new Map<number, number>());
    const closingRef = useRef(false);
    const settingsRef = useRef<Settings>(defaultSettings);
    const lastSavedJsonRef = useRef<string | null>(null);
    // Pila de pestañas cerradas (Ctrl+Shift+T) y puente para atajos de teclado:
    // el keydown registrado una sola vez delega en estas acciones frescas.
    const closedTabsRef = useRef<Array<{ spaceId: number; tab: Tab }>>([]);
    const actionsRef = useRef<Record<string, (...args: number[]) => void>>({});
    const noteRef = useRef("");
    const wallpaperInputRef = useRef<HTMLInputElement | null>(null);
    const cancelNameRef = useRef(false);
    const profileChipRef = useRef<HTMLButtonElement | null>(null);
    const sidebarRef = useRef<HTMLElement | null>(null);

    const activeSpace = spaces.find(s => s.id === activeSpaceId) ?? null;
    const activeTabId = activeSpace?.activeTabId ?? 0;
    const activePage = activeSpace?.tabs.find(t => t.id === activeTabId) ?? null;
    const isFavorited = !!activePage?.url && favorites.some(f => f.url === activePage.url) && view === "tab";

    useEffect(() => { activeTabRef.current = activeTabId; }, [activeTabId]);
    useEffect(() => { activeSpaceIdRef.current = activeSpaceId; }, [activeSpaceId]);
    useEffect(() => { spacesRef.current = spaces; }, [spaces]);
    useEffect(() => { viewRef.current = view; }, [view]);
    useEffect(() => { sidebarOpenRef.current = sidebarOpen; }, [sidebarOpen]);
    useEffect(() => { historyRef.current = history; }, [history]);
    useEffect(() => { favoritesRef.current = favorites; }, [favorites]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    useEffect(() => { noteRef.current = note; }, [note]);

    // Aplica el tema elegido al atributo del documento (las variables CSS
    // cambian con `:root[data-theme=…]`).
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", settings.theme);
    }, [settings.theme]);

    // Reloj en tiempo real: solo corre mientras se ve el Inicio.
    useEffect(() => {
        if (view !== "home") return;
        const timer = window.setInterval(() => setNowTick(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, [view]);

    function labelFor(id: number) {
        return `tab-${id}`;
    }

    function patchSpace(id: number, patch: Partial<Space>) {
        setSpaces(current => current.map(s => (s.id === id ? { ...s, ...patch } : s)));
    }

    function recordHistory(url: string, title?: string) {
        if (!url || !/^https?:/.test(url)) return;
        // Un espacio privado no guarda historial (B3).
        const active = spacesRef.current.find(s => s.id === activeSpaceIdRef.current);
        if (active?.priv) return;
        const label = title || hostOf(url);
        setHistory(current => {
            if (current[0]?.url === url) return current;
            const entry: HistoryEntry = { id: nextId(), url, title: label, visitedAt: Date.now() };
            return [entry, ...current].slice(0, HISTORY_CAP);
        });
    }

    // Rect del contenedor padre (el cuerpo de la pestaña) en píxeles físicos.
    // Recortado a la ventana visible: un webview nunca debe pedir más tamaño
    // del que muestra la ventana (su "size request" agrandaría el contenedor
    // GTK y empujaría el cromo, p. ej. la barra lateral, fuera de pantalla).
    function physicalRect(host: HTMLDivElement) {
        const rect = host.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const maxW = Math.round(window.innerWidth * dpr);
        const maxH = Math.round(window.innerHeight * dpr);
        const x = Math.max(0, Math.round((rect.left + window.scrollX) * dpr));
        const y = Math.max(0, Math.round((rect.top + window.scrollY) * dpr));
        const width = Math.min(Math.round(rect.width * dpr), Math.max(0, maxW - x));
        const height = Math.min(Math.round(rect.height * dpr), Math.max(0, maxH - y));
        return { x, y, width, height };
    }

    // Diagnóstico: compara lo pedido con lo que el entorno devuelve realmente.
    async function diagnose(wv: Webview, target: { x: number; y: number; width: number; height: number }) {
        try {
            const pos = await wv.position();
            const size = await wv.size();
            console.debug("[kata] bounds objetivo", target, "→ real", { x: pos.x, y: pos.y, width: size.width, height: size.height }, "dpr", window.devicePixelRatio);
        } catch { /* el webview puede estar cerrándose */ }
    }

    // Aplica la posición y el tamaño del contenedor a todos los webviews.
    function syncBounds(readback = false) {
        if (occludeRef.current) return; // ocultos por un overlay (sugerencias/conmutador)
        const host = hostRef.current;
        if (!host) return;
        const target = physicalRect(host);
        const position = new PhysicalPosition(target.x, target.y);
        const size = new PhysicalSize(target.width, target.height);
        for (const { wv } of webviews.current.values()) {
            wv.setPosition(position).catch(() => {});
            wv.setSize(size).catch(() => {});
        }
        if (readback && DEBUG) {
            const active = webviews.current.get(activeTabRef.current);
            if (active) void diagnose(active.wv, target);
        }
    }

    // Crea a demanda el webview de una pestaña (una sola vez, incluso con StrictMode).
    async function ensureWebview(tab: Tab): Promise<WebviewEntry | null> {
        const existing = webviews.current.get(tab.id);
        if (existing) return existing;

        const pending = creating.current.get(tab.id);
        if (pending) return pending;

        const host = hostRef.current;
        if (!host) return null;

        const bounds = physicalRect(host);
        const label = labelFor(tab.id);

        const promise = (async () => {
            setLoading(true);
            await invoke("create_tab_webview", { label, url: tab.url, ...bounds });
            const alive = spacesRef.current.some(s => s.tabs.some(t => t.id === tab.id));
            if (!alive) {
                // La pestaña se cerró mientras se creaba: no dejar huérfanos.
                const wv = await Webview.getByLabel(label);
                if (wv) await wv.close().catch(() => {});
                return null;
            }
            const wv = await Webview.getByLabel(label);
            if (!wv) throw new Error(`webview ${label} no disponible`);
            const entry: WebviewEntry = { wv, ready: Promise.resolve() };
            webviews.current.set(tab.id, entry);
            setLoading(false);
            return entry;
        })().catch(error => {
            setLoading(false);
            console.error("no se pudo crear el webview", error);
            return null;
        });

        creating.current.set(tab.id, promise);
        try {
            return await promise;
        } finally {
            creating.current.delete(tab.id);
        }
    }

    // Arranque: restaura el estado persistido o usa el semilla.
    useEffect(() => {
        let disposed = false;
        (async () => {
            let state: PersistedState | null = null;
            try {
                const raw = await invoke<string>("load_state");
                const parsed = JSON.parse(raw) as PersistedState;
                if (parsed && Array.isArray(parsed.spaces) && parsed.spaces.length > 0 && parsed.spaces.every(s => Array.isArray(s.tabs))) {
                    state = parsed;
                }
            } catch { /* primer arranque */ }
            if (disposed) return;

            // Migración del fondo antiguo (estaba dentro del JSON de estado) →
            // archivo aparte, para que los autoguardados no reescriban MB.
            const legacy = (state?.settings as { homeWallpaper?: string } | undefined)?.homeWallpaper;
            if (state && legacy) {
                void invoke("save_wallpaper", { contents: legacy }).catch(() => {});
                setWallpaper(legacy);
            }
            try {
                const wp = await invoke<string>("load_wallpaper");
                if (wp) setWallpaper(wp);
            } catch { /* sin fondo guardado */ }
            if (disposed) return;

            if (state) {
                const rawSettings = { ...(state.settings ?? {}) } as Record<string, unknown>;
                delete rawSettings.homeWallpaper;
                const merged = { ...defaultSettings, ...rawSettings } as Settings;
                const normalize = (list: Space[]): Space[] =>
                    list.map(s => ({ ...s, priv: Boolean(s.priv) }));
                setSettings(merged);
                setHistory(Array.isArray(state.history) ? state.history : []);
                setFavorites(Array.isArray(state.favorites) ? state.favorites : []);
                setSidebarOpen(state.sidebarOpen ?? true);
                setNote(typeof state.note === "string" ? state.note : "");
                if (merged.startRestoreTabs) {
                    const sid = state.spaces.some(s => s.id === state.activeSpaceId)
                        ? state.activeSpaceId
                        : state.spaces[0].id;
                    setSpaces(normalize(state.spaces));
                    setActiveSpaceId(sid);
                    const s = state.spaces.find(x => x.id === sid)!;
                    const t = s.tabs.find(x => x.id === s.activeTabId);
                    if (t) {
                        setView(t.url ? "tab" : "home");
                        setAddress(t.url);
                        lastActivatedRef.current.set(t.id, Date.now());
                    } else {
                        setView("home");
                        setAddress("");
                    }
                } else {
                    // Inicio limpio: conserva espacios y datos, pero vacía las
                    // pestañas de la sesión anterior.
                    setSpaces(state.spaces.map(s => ({ ...s, priv: Boolean(s.priv), tabs: [], activeTabId: 0 })));
                    setActiveSpaceId(state.spaces[0].id);
                    setView("home");
                    setAddress("");
                }
                if (!merged.onboarded) {
                    // Primer arranque aún sin completar: pasa por la bienvenida
                    // antes de la vista normal.
                    setView("welcome");
                    setAddress("");
                }
            } else {
                const d = defaultState();
                setSpaces(d.spaces);
                setActiveSpaceId(d.activeSpaceId);
                setHistory([]);
                setFavorites([]);
                setSidebarOpen(true);
                setSettings(defaultSettings);
                setView("welcome");
                setAddress("");
            }
            setBooted(true);
        })();
        return () => { disposed = true; };
    }, []);

    // Guardado explícito al cerrar la ventana (no perder nada al salir).
    useEffect(() => {
        let disposed = false;
        let unlisten: UnlistenFn | null = null;
        getCurrentWindow()
            .onCloseRequested(async event => {
                if (closingRef.current) return;
                closingRef.current = true;
                event.preventDefault();
                const state: PersistedState = {
                    version: 1,
                    activeSpaceId: activeSpaceIdRef.current,
                    spaces: spacesRef.current,
                    history: historyRef.current,
                    favorites: favoritesRef.current,
                    sidebarOpen: sidebarOpenRef.current,
                    settings: settingsRef.current,
                    note: noteRef.current,
                };
                try {
                    const json = JSON.stringify(state);
                    lastSavedJsonRef.current = json;
                    await invoke("save_state", { contents: json });
                } catch (err) {
                    console.error("no se pudo guardar el estado al cerrar", err);
                }
                try {
                    await getCurrentWindow().destroy();
                } catch { /* ya cerrada */ }
            })
            .then(fn => {
                if (disposed) fn();
                else unlisten = fn;
            })
            .catch(err => console.error("no se pudo escuchar el cierre", err));
        return () => { disposed = true; unlisten?.(); };
    }, []);

    // Autoguardado con debounce ante cualquier cambio de estado persistible.
    // A3: si el JSON resultante es idéntico al último guardado, no se escribe.
    useEffect(() => {
        if (!booted) return;
        const timer = window.setTimeout(() => {
            const state: PersistedState = {
                version: 1,
                activeSpaceId,
                spaces,
                history,
                favorites,
                sidebarOpen,
                settings,
                note,
            };
            const json = JSON.stringify(state);
            if (json === lastSavedJsonRef.current) return;
            lastSavedJsonRef.current = json;
            invoke("save_state", { contents: json })
                .catch(err => console.error("no se pudo guardar el estado", err));
        }, 500);
        return () => window.clearTimeout(timer);
    }, [booted, activeSpaceId, spaces, history, favorites, sidebarOpen, settings, note]);

    // Recibe las URL reales navegadas dentro de cada webview (búsquedas, enlaces, redirecciones).
    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        let unlistenTitle: UnlistenFn | null = null;
        let disposed = false;
        getCurrentWebview()
            .listen<[string, string]>("kata://navigation", (event) => {
                const [label, url] = event.payload;
                const id = Number(label.replace(/^tab-/, ""));
                if (Number.isNaN(id) || !/^https?:/.test(url)) return;
                const sp = spacesRef.current.find(s => s.tabs.some(t => t.id === id));
                const tab = sp?.tabs.find(t => t.id === id);
                if (!sp || !tab || tab.url === url) return;
                const domain = hostOf(url);
                patchSpace(sp.id, { tabs: sp.tabs.map(t => (t.id === id ? { ...t, url, domain } : t)) });
                recordHistory(url, tab.title);
                // No pisa la barra mientras el usuario está editando una dirección.
                if (id === activeTabRef.current && viewRef.current === "tab" && !typingRef.current) setAddress(url);
            })
            .then(fn => {
                if (disposed) fn();
                else unlisten = fn;
            })
            .catch(err => console.error("no se pudo escuchar navegaciones", err));
        // Título real de la página (Rust lo emite desde `connect_title_notify`):
        // la pestaña muestra el <title> del contenido, no el dominio con el que
        // se abrió. Cubre también los cambios de título de SPAs (YouTube, etc.).
        getCurrentWebview()
            .listen<[string, string]>("kata://title", (event) => {
                const [label, title] = event.payload;
                const id = Number(label.replace(/^tab-/, ""));
                if (Number.isNaN(id) || !title.trim()) return;
                const sp = spacesRef.current.find(s => s.tabs.some(t => t.id === id));
                const tab = sp?.tabs.find(t => t.id === id);
                if (!sp || !tab || tab.title === title) return;
                patchSpace(sp.id, { tabs: sp.tabs.map(t => (t.id === id ? { ...t, title } : t)) });
                // Refleja el título nuevo en la entrada más reciente del historial.
                setHistory(current => {
                    const idx = current.findIndex(h => h.url === tab.url);
                    if (idx === -1 || current[idx].title === title) return current;
                    const next = [...current];
                    next[idx] = { ...next[idx], title };
                    return next;
                });
            })
            .then(fn => {
                if (disposed) fn();
                else unlistenTitle = fn;
            })
            .catch(err => console.error("no se pudo escuchar títulos", err));
        return () => { disposed = true; unlisten?.(); unlistenTitle?.(); };
    }, []);

    // Suspensión por inactividad: libera el proceso de pestañas ocultas
    // transcurrido un respiro. Al reactivarlas, `ensureWebview` las recrea.
    // Respeta las preferencias: se desactiva por completo si el usuario lo
    // pide, y nunca suspende los dominios exentos.
    useEffect(() => {
        const sweep = () => {
            const s = settingsRef.current;
            if (!s.suspendEnabled) return;
            const now = Date.now();
            const visible = viewRef.current === "tab" ? activeTabRef.current : -1;
            for (const [id, entry] of webviews.current) {
                if (id === visible) continue;
                const tab = spacesRef.current.flatMap(sp => sp.tabs).find(t => t.id === id);
                if (!tab) continue;
                if (isExemptUrl(tab.url, s.suspendExemptDomains)) continue;
                const since = lastActivatedRef.current.get(id);
                if (since === undefined || now - since < s.suspendAfterMs) continue;
                webviews.current.delete(id);
                creating.current.delete(id);
                entry.ready.then(() => entry.wv.close().catch(() => {})).catch(() => {});
                if (DEBUG) console.debug(`[kata] pestaña ${id} suspendida (proceso liberado)`);
            }
        };
        sweep();
        const timer = window.setInterval(sweep, SUSPEND_SWEEP_MS);
        return () => window.clearInterval(timer);
    }, []);

    // Mantiene en un ref las acciones con las closures más recientes: el
    // listener de teclado se registra una sola vez y delega aquí (evita
    // atajos con estado obsoleto de renders anteriores).
    useEffect(() => {
        actionsRef.current = {
            newTab: () => createTab(),
            closeActiveTab: () => { if (activeTabRef.current) closeTab(activeTabRef.current); },
            reload: () => toolbarAction("reload"),
            back: () => toolbarAction("back"),
            forward: () => toolbarAction("forward"),
            focusAddress: () => { addressRef.current?.focus(); addressRef.current?.select(); },
            toggleFav: () => toggleFavorite(),
            reopen: () => reopenTab(),
            switcher: () => toggleSwitcher(),
            nth: (i: number) => {
                const sp = spacesRef.current.find(s => s.id === activeSpaceIdRef.current);
                const t = sp?.tabs[i];
                if (t) selectTab(t.id);
            },
            adjacent: (dir: number) => {
                const sp = spacesRef.current.find(s => s.id === activeSpaceIdRef.current);
                if (!sp || sp.tabs.length === 0) return;
                const idx = sp.tabs.findIndex(t => t.id === sp.activeTabId);
                const next = sp.tabs[(idx + dir + sp.tabs.length) % sp.tabs.length];
                selectTab(next.id);
            },
        };
    });

    // Atajos de teclado al estilo navegador. Viven en el cromo; cuando el
    // foco está dentro de una página (webview nativo de la pestaña) aplican
    // los zoom_hotkeys propios de WebKit (Ctrl+±/0).
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const act = actionsRef.current;
            const k = event.key.toLowerCase();
            const mod = event.ctrlKey || event.metaKey;
            if (mod && event.shiftKey && k === "t") { event.preventDefault(); act.reopen(); }
            else if (mod && k === "t") { event.preventDefault(); act.newTab(); }
            else if (mod && k === "w") { event.preventDefault(); act.closeActiveTab(); }
            else if (mod && k === "tab") { event.preventDefault(); act.adjacent(event.shiftKey ? -1 : 1); }
            else if (mod && /^[1-9]$/.test(k)) { event.preventDefault(); act.nth(Number(k) - 1); }
            else if (mod && k === "l") { event.preventDefault(); act.focusAddress(); }
            else if (mod && k === "r") { event.preventDefault(); act.reload(); }
            else if (mod && k === "d") { event.preventDefault(); act.toggleFav(); }
            else if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); act.back(); }
            else if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); act.forward(); }
            else if (mod && k === "p") { event.preventDefault(); act.switcher(); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // Cierra los menús flotantes (espacios, pestañas y perfil) con clic fuera
    // o con Escape.
    useEffect(() => {
        if (tabsMenuFor === null && menuId === null && !profileOpen) return;
        const closeMenus = (event?: PointerEvent) => {
            // Un clic dentro de un menú/popover abierto no debe cerrarlo: si lo
            // cerráramos en el pointerdown, React desmontaría el menú antes de
            // dispararse el `click` y sus botones nunca ejecutarían su acción.
            const target = event?.target as Element | null;
            if (target && typeof target.closest === "function" && target.closest(".space-menu, .space-tabs-menu, .profile-pop")) return;
            setTabsMenuFor(null); setTabsMenuPos(null); setMenuId(null); setMenuPos(null);
            setProfileOpen(false); setProfilePos(null); setEditingProfileName(false);
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenus(); };
        window.addEventListener("pointerdown", closeMenus);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("pointerdown", closeMenus);
            window.removeEventListener("keydown", onKey);
        };
    }, [tabsMenuFor, menuId, profileOpen]);

    // Conmutador rápido (B2): flechas + Enter + Escape mientras está abierto.
    useEffect(() => {
        if (!switcherOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") { setSwitcherOpen(false); return; }
            if (switcherItems.length === 0) return;
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setSwitcherIdx(i => Math.min(i + 1, switcherItems.length - 1));
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSwitcherIdx(i => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
                const item = switcherItems[switcherIdx];
                if (item) activateSwitcherItem(item);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [switcherOpen, switcherItems, switcherIdx]);

    // Oculta temporalmente los webviews mientras un overlay del cromo los
    // cubriría (sugerencias abiertas o conmutador): se pintan por encima del
    // HTML, así que sin esto taparían el panel. Al cerrar, se restauran.
    useEffect(() => {
        const need = switcherOpen || (suggestOpen && suggestions.length > 0)
            || menuId !== null || tabsMenuFor !== null || profileOpen;
        if (need === occludeRef.current) return;
        occludeRef.current = need;
        const targetNeed = need;
        void (async () => {
            if (need) {
                const saved = new Map<number, { x: number; y: number; width: number; height: number }>();
                for (const [id, { wv }] of webviews.current) {
                    try {
                        const pos = await wv.position();
                        const size = await wv.size();
                        saved.set(id, { x: pos.x, y: pos.y, width: size.width, height: size.height });
                    } catch { /* webview cerrado */ }
                }
                occludedBoundsRef.current = saved;
            }
            for (const [id, { wv }] of webviews.current) {
                if (occludeRef.current !== targetNeed) return; // cambió a mitad de camino
                if (need) {
                    await wv.setPosition(new PhysicalPosition(-20000, -20000)).catch(() => {});
                } else {
                    const s = occludedBoundsRef.current.get(id);
                    if (s) {
                        await wv.setPosition(new PhysicalPosition(s.x, s.y)).catch(() => {});
                        await wv.setSize(new PhysicalSize(s.width, s.height)).catch(() => {});
                    }
                }
            }
            if (!need) {
                occludedBoundsRef.current.clear();
                if (occludeRef.current === targetNeed) syncBounds();
            }
        })();
    }, [switcherOpen, suggestOpen, suggestions.length, menuId, tabsMenuFor, profileOpen]);

    function selectTab(tabId: number) {
        const sp = spacesRef.current.find(s => s.id === activeSpaceId);
        const tab = sp?.tabs.find(t => t.id === tabId);
        if (!sp || !tab) return;
        lastActivatedRef.current.set(tabId, Date.now());
        patchSpace(activeSpaceId, { activeTabId: tabId });
        setView(tab.url ? "tab" : "home");
        setAddress(tab.url);
    }

    function createTab() {
        const sp = spacesRef.current.find(s => s.id === activeSpaceId);
        if (!sp) return;
        const tabId = nextId();
        const tab: Tab = { id: tabId, title: "Nueva pestaña", domain: "", url: "", tone: toneFor(tabId) };
        lastActivatedRef.current.set(tabId, Date.now());
        patchSpace(activeSpaceId, { tabs: [...sp.tabs, tab], activeTabId: tabId });
        setView("home");
        setAddress("");
    }

    // Navegación central: texto de la barra → URL real. Dicha por el propio
    // formulario y por las sugerencias (B1) y el conmutador (B2).
    function go(raw: string) {
        const trimmed = raw.trim();
        if (!trimmed) return;
        // Dominios/IP/localhost directos a https; lo demás se busca en el motor elegido.
        const url = looksLikeUrl(trimmed)
            ? (trimmed.includes("://") ? trimmed : `https://${trimmed}`)
            : SEARCH_URLS[settingsRef.current.searchEngine](trimmed);
        const title = hostOf(url);
        addressRef.current?.blur();
        setAddress(url);
        setView("tab");
        const sp = spacesRef.current.find(s => s.id === activeSpaceIdRef.current);
        if (!sp) return;
        const active = sp.tabs.find(t => t.id === sp.activeTabId);
        if (active) {
            patchSpace(activeSpaceIdRef.current, { tabs: sp.tabs.map(t => (t.id === active.id ? { ...t, url, title, domain: title } : t)) });
            const entry = webviews.current.get(active.id);
            if (entry) {
                entry.ready.then(() =>
                    invoke("navigate_webview", { label: labelFor(active.id), url })
                        .catch(err => console.error("no se pudo navegar la página", err)),
                );
            }
        } else {
            const tabId = nextId();
            const tab: Tab = { id: tabId, title, domain: title, url, tone: toneFor(tabId) };
            lastActivatedRef.current.set(tabId, Date.now());
            patchSpace(activeSpaceIdRef.current, { tabs: [...sp.tabs, tab], activeTabId: tabId });
        }
        recordHistory(url, title);
    }

    function navigate(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        go(address);
    }

    function toolbarAction(action: "back" | "forward" | "reload") {
        if (!activePage || !activePage.url) return;
        const entry = webviews.current.get(activePage.id);
        if (!entry) return;
        entry.ready.then(() => {
            if (action === "reload" && /^https?:/.test(activePage.url)) {
                // Recarga con navegación nativa (proceso UI): funciona incluso
                // si el WebProcess de la página se cayó (p. ej. crash de
                // GStreamer en media), cosa que `location.reload()` vía eval
                // no puede hacer porque el proceso ya no existe.
                invoke("navigate_webview", { label: labelFor(activePage.id), url: activePage.url })
                    .catch(err => console.error("no se pudo recargar la página", err));
                return;
            }
            invoke("webview_action", { label: labelFor(activePage.id), action })
                .catch(err => console.error("no se pudo ejecutar la acción", err));
        });
    }

    function closeTab(id: number) {
        const entry = webviews.current.get(id);
        if (entry) {
            webviews.current.delete(id);
            creating.current.delete(id);
            entry.ready.then(() => entry.wv.close().catch(() => {})).catch(() => {});
        }
        lastActivatedRef.current.delete(id);
        const sp = spacesRef.current.find(s => s.id === activeSpaceId);
        if (!sp) return;
        const toClose = sp.tabs.find(t => t.id === id);
        if (toClose) {
            closedTabsRef.current.push({ spaceId: sp.id, tab: toClose });
            if (closedTabsRef.current.length > 20) closedTabsRef.current.shift();
        }
        const remaining = sp.tabs.filter(t => t.id !== id);
        if (activeTabId === id) {
            if (remaining.length) {
                const next = remaining[remaining.length - 1];
                lastActivatedRef.current.set(next.id, Date.now());
                patchSpace(activeSpaceId, { tabs: remaining, activeTabId: next.id });
                setView(next.url ? "tab" : "home");
                setAddress(next.url);
            } else {
                patchSpace(activeSpaceId, { tabs: remaining, activeTabId: 0 });
                setView("home");
                setAddress("");
            }
        } else {
            patchSpace(activeSpaceId, { tabs: remaining });
        }
    }

    // ---- Espacios ---------------------------------------------------------

    // Abre una pestaña de otro espacio sin pasar por `switchSpace` (cambia
    // espacio y pestaña de una vez, con los refs frescos).
    function openTabInSpace(spaceId: number, tabId: number) {
        const sp = spacesRef.current.find(s => s.id === spaceId);
        const tab = sp?.tabs.find(t => t.id === tabId);
        if (!sp || !tab) return;
        lastActivatedRef.current.set(tabId, Date.now());
        activeSpaceIdRef.current = spaceId;
        setActiveSpaceId(spaceId);
        patchSpace(spaceId, { activeTabId: tabId });
        setView(tab.url ? "tab" : "home");
        setAddress(tab.url);
        setTabsMenuFor(null);
        setTabsMenuPos(null);
        setMenuId(null);
    }

    function newTabInSpace(spaceId: number) {
        const sp = spacesRef.current.find(s => s.id === spaceId);
        if (!sp) return;
        const tabId = nextId();
        const tab: Tab = { id: tabId, title: "Nueva pestaña", domain: "", url: "", tone: toneFor(tabId) };
        lastActivatedRef.current.set(tabId, Date.now());
        activeSpaceIdRef.current = spaceId;
        setActiveSpaceId(spaceId);
        patchSpace(spaceId, { tabs: [...sp.tabs, tab], activeTabId: tabId });
        setView("home");
        setAddress("");
        setTabsMenuFor(null);
        setTabsMenuPos(null);
        setMenuId(null);
    }

    // Ctrl+Shift+T: reabre la última pestaña cerrada (vuelve a su espacio).
    function reopenTab() {
        const lastClosed = closedTabsRef.current.pop();
        if (!lastClosed) return;
        const sp = spacesRef.current.find(s => s.id === lastClosed.spaceId);
        if (!sp) return;
        const tab = { ...lastClosed.tab };
        lastActivatedRef.current.set(tab.id, Date.now());
        activeSpaceIdRef.current = lastClosed.spaceId;
        setActiveSpaceId(lastClosed.spaceId);
        setSpaces(current => current.map(s => (s.id === lastClosed.spaceId ? { ...s, tabs: [...s.tabs, tab], activeTabId: tab.id } : s)));
        setView("tab");
        setAddress(tab.url);
    }

    // Popover "ver pestañas": se ancla en coordenadas fijas (la lista de
    // espacios desplaza internamente y recortaría un popover absoluto).
    function toggleTabsMenu(spaceId: number, anchor: HTMLElement) {
        const willOpen = tabsMenuFor !== spaceId;
        setMenuId(null);
        setMenuPos(null);
        setTabsMenuFor(willOpen ? spaceId : null);
        setTabsMenuPos(null);
        if (willOpen) {
            const r = anchor.getBoundingClientRect();
            setTabsMenuPos({ x: r.left, y: r.bottom + 6 });
        }
    }

    function toggleMenu(spaceId: number, anchor: HTMLElement) {
        const willOpen = menuId !== spaceId;
        setTabsMenuFor(null);
        setTabsMenuPos(null);
        setMenuId(willOpen ? spaceId : null);
        setMenuPos(null);
        if (willOpen) {
            const r = anchor.getBoundingClientRect();
            setMenuPos({ right: Math.max(4, window.innerWidth - r.right), top: r.bottom + 3 });
        }
    }

    function createSpace() {
        const id = nextId();
        const name = `Espacio ${spacesRef.current.length + 1}`;
        const space: Space = { id, name, tone: "orange", activeTabId: 0, tabs: [], priv: false };
        setSpaces(current => [...current, space]);
        setActiveSpaceId(id);
        setView("home");
        setAddress("");
    }

    function togglePrivate(id: number) {
        const current = spacesRef.current.find(s => s.id === id);
        if (!current) return;
        patchSpace(id, { priv: !current.priv });
        setMenuId(null);
        setMenuPos(null);
    }

    function switchSpace(id: number) {
        if (id === activeSpaceId) return;
        const s = spacesRef.current.find(x => x.id === id);
        if (!s) return;
        setActiveSpaceId(id);
        const t = s.tabs.find(x => x.id === s.activeTabId);
        if (t) {
            lastActivatedRef.current.set(t.id, Date.now());
            setView(t.url ? "tab" : "home");
            setAddress(t.url);
        } else {
            setView("home");
            setAddress("");
        }
    }

    function closeSpace(id: number) {
        if (spacesRef.current.length <= 1) return;
        const s = spacesRef.current.find(x => x.id === id);
        if (!s) return;
        for (const tab of s.tabs) {
            const entry = webviews.current.get(tab.id);
            if (entry) {
                webviews.current.delete(tab.id);
                creating.current.delete(tab.id);
                entry.ready.then(() => entry.wv.close().catch(() => {})).catch(() => {});
            }
            lastActivatedRef.current.delete(tab.id);
        }
        const remaining = spacesRef.current.filter(x => x.id !== id);
        setSpaces(current => current.filter(x => x.id !== id));
        setMenuId(null);
        setConfirmingId(null);
        if (activeSpaceId === id) {
            const next = remaining[remaining.length - 1];
            setActiveSpaceId(next.id);
            const t = next.tabs.find(x => x.id === next.activeTabId);
            if (t) {
                lastActivatedRef.current.set(t.id, Date.now());
                setView(t.url ? "tab" : "home");
                setAddress(t.url);
            } else {
                setView("home");
                setAddress("");
            }
        }
    }

    function beginRename(id: number) {
        const s = spacesRef.current.find(x => x.id === id);
        if (!s) return;
        setRenamingName(s.name);
        setMenuId(null);
        setRenamingId(id);
    }

    function commitRename() {
        if (renamingId === null) return;
        const name = renamingName.trim() || "Espacio";
        patchSpace(renamingId, { name });
        setRenamingId(null);
    }

    function beginClose(id: number) {
        if (confirmingId === id) {
            closeSpace(id);
            return;
        }
        setConfirmingId(id);
        window.setTimeout(() => setConfirmingId(current => (current === id ? null : current)), 4000);
    }

    // ---- Historial y favoritos --------------------------------------------

    function openEntry(url: string, title?: string) {
        const sp = spacesRef.current.find(s => s.id === activeSpaceId);
        if (!sp) return;
        const label = title || hostOf(url);
        const active = sp.tabs.find(t => t.id === sp.activeTabId);
        if (!active) {
            openInNewTab(url, label);
            return;
        }
        const newTab = { ...active, url, title: label, domain: hostOf(url) };
        lastActivatedRef.current.set(active.id, Date.now());
        patchSpace(activeSpaceId, { tabs: sp.tabs.map(t => (t.id === active.id ? newTab : t)) });
        const entry = webviews.current.get(active.id);
        if (entry) {
            entry.ready.then(() =>
                invoke("navigate_webview", { label: labelFor(active.id), url })
                    .catch(err => console.error("no se pudo abrir la entrada", err)),
            );
        }
        setView("tab");
        setAddress(url);
        recordHistory(url, label);
    }

    function openInNewTab(url: string, title?: string) {
        const sp = spacesRef.current.find(s => s.id === activeSpaceId);
        if (!sp) return;
        const tabId = nextId();
        const label = title || hostOf(url);
        const tab: Tab = { id: tabId, title: label, domain: hostOf(url), url, tone: toneFor(tabId) };
        lastActivatedRef.current.set(tabId, Date.now());
        patchSpace(activeSpaceId, { tabs: [...sp.tabs, tab], activeTabId: tabId });
        setView("tab");
        setAddress(url);
        recordHistory(url, label);
    }

    function openSuggestion(sg: Suggestion) {
        setSuggestOpen(false);
        suggestTouchedRef.current = false;
        if (sg.kind === "buscar") {
            go(sg.url);
        } else {
            openEntry(sg.url, sg.title);
        }
    }

    function toggleSwitcher() {
        if (switcherOpen) { setSwitcherOpen(false); return; }
        setSwitcherOpen(true);
        setSwitcherQuery("");
        setSwitcherIdx(0);
        window.setTimeout(() => switcherInputRef.current?.focus(), 0);
    }

    function activateSwitcherItem(item: SwitcherItem) {
        setSwitcherOpen(false);
        if (item.type === "space") {
            if (item.spaceId !== activeSpaceIdRef.current) switchSpace(item.spaceId);
        } else {
            openTabInSpace(item.spaceId, item.tabId);
        }
    }

    function toggleFavorite() {
        if (!activePage?.url || !/^https?:/.test(activePage.url)) return;
        const url = activePage.url;
        setFavorites(current => {
            if (current.some(f => f.url === url)) return current.filter(f => f.url !== url);
            const fav: Favorite = { id: nextId(), url, title: activePage.title || hostOf(url), domain: hostOf(url), addedAt: Date.now() };
            return [fav, ...current];
        });
    }

    function clearHistory() {
        setHistory([]);
    }

    function addExemptDomain(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const raw = exemptInput.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
        if (!raw) return;
        setSettings(current => current.suspendExemptDomains.includes(raw)
            ? current
            : { ...current, suspendExemptDomains: [...current.suspendExemptDomains, raw] });
        setExemptInput("");
    }

    function removeExemptDomain(domain: string) {
        setSettings(current => ({ ...current, suspendExemptDomains: current.suspendExemptDomains.filter(d => d !== domain) }));
    }

    // Botones destructivos con doble clic de confirmación.
    function clickClear(kind: "history" | "favorites") {
        if (confirmClear === kind) {
            if (kind === "history") setHistory([]);
            else setFavorites([]);
            setConfirmClear(null);
        } else {
            setConfirmClear(kind);
        }
    }

    // Restablece todo el navegador al primer uso: cierra los webviews de todas
    // las pestañas, borra datos, perfil, tema, fondo y espacios, y lleva al
    // pase de bienvenida como si fuera la primera vez.
    function resetAll() {
        for (const sp of spacesRef.current) {
            for (const tab of sp.tabs) {
                const entry = webviews.current.get(tab.id);
                if (entry) {
                    webviews.current.delete(tab.id);
                    creating.current.delete(tab.id);
                    entry.ready.then(() => entry.wv.close().catch(() => {})).catch(() => {});
                }
                lastActivatedRef.current.delete(tab.id);
            }
        }
        occludedBoundsRef.current = new Map();
        occludeRef.current = false;
        closedTabsRef.current = [];
        const fresh = defaultState();
        setSpaces(fresh.spaces);
        setActiveSpaceId(fresh.activeSpaceId);
        setHistory([]);
        setFavorites([]);
        setNote("");
        setSidebarOpen(true);
        setWallpaper("");
        void invoke("clear_wallpaper").catch(() => {});
        setSettings(defaultSettings);
        // Cierra cualquier popover/overlay abierto.
        setMenuId(null); setMenuPos(null);
        setTabsMenuFor(null); setTabsMenuPos(null);
        setProfileOpen(false); setProfilePos(null);
        setSwitcherOpen(false); setSuggestOpen(false); setSuggestIdx(0);
        setEditingName(false); setNameDraft("");
        setConfirmClear(null); setConfirmingId(null);
        // Vuelve a mostrar la bienvenida del primer arranque.
        setView("welcome");
        setAddress("");
    }

    function toggleReset() {
        if (confirmReset) {
            resetAll();
            setConfirmReset(false);
        } else {
            setConfirmReset(true);
            window.setTimeout(() => setConfirmReset(false), 4000);
        }
    }

    // Contactos clicables: las webs (GitHub, LinkedIn) se abren en una pestaña
    // nueva; el correo y el teléfono se copian al portapapeles con feedback.
    function openContact(entry: { label: string; value: string; kind: "link" | "copy" }) {
        if (entry.kind === "copy") {
            void navigator.clipboard.writeText(entry.value)
                .then(() => {
                    setContactCopied(entry.label);
                    window.setTimeout(() => setContactCopied(current => (current === entry.label ? null : current)), 1800);
                })
                .catch(() => {});
            return;
        }
        openInNewTab(entry.value, entry.label);
    }

    const setSuspendDelay = (ms: number) => setSettings(current => ({ ...current, suspendAfterMs: ms }));
    const setStartRestore = (restore: boolean) => setSettings(current => ({ ...current, startRestoreTabs: restore }));
    const setEngine = (engine: Settings["searchEngine"]) => setSettings(current => ({ ...current, searchEngine: engine }));
    const setTheme = (theme: ThemeName) => setSettings(current => ({ ...current, theme }));

    function pickWallpaper() { wallpaperInputRef.current?.click(); }

    function onPickWallpaper(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = ""; // permite volver a elegir la misma imagen
        if (!file) return;
        const MAX = 8 * 1024 * 1024; // 8 MiB — se guarda en archivo aparte
        if (file.size > MAX) {
            setWallpaperMsg("La imagen es demasiado grande (máx. 8 MB).");
            return;
        }
        setWallpaperMsg("");
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result ?? "");
            if (result.startsWith("data:image/")) {
                // El fondo vive en `wallpaper.data` (archivo aparte), no en el
                // JSON de estado: los autoguardados siguen siendo ligeros.
                setWallpaper(result);
                void invoke("save_wallpaper", { contents: result }).catch(() => {
                    setWallpaperMsg("No se pudo guardar la imagen.");
                });
            }
        };
        reader.readAsDataURL(file);
    }

    function removeWallpaper() {
        setWallpaper("");
        void invoke("clear_wallpaper").catch(() => {});
    }

    // Finaliza el pase de bienvenida: marca el arranque como completado y
    // salta a la vista de Inicio con el perfil ya configurado.
    function completeOnboarding() {
        setSettings(current => ({ ...current, onboarded: true }));
        setView("home");
        setAddress("");
        const sp = spacesRef.current.find(s => s.id === activeSpaceIdRef.current);
        const tab = sp?.tabs.find(t => t.id === sp.activeTabId);
        if (tab) {
            lastActivatedRef.current.set(tab.id, Date.now());
            setView(tab.url ? "tab" : "home");
            setAddress(tab.url);
        }
    }

    function clearNote() { setNote(""); }

    function startEditName() {
        setNameDraft(settings.userName);
        cancelNameRef.current = false;
        setEditingName(true);
    }
    function saveUserName() {
        setSettings(current => ({ ...current, userName: nameDraft.trim() }));
        setEditingName(false);
    }
    function commitUserName() {
        if (cancelNameRef.current) {
            cancelNameRef.current = false;
            return;
        }
        saveUserName();
    }

    function toggleProfile() {
        if (profileOpen) { closeProfile(); return; }
        const el = profileChipRef.current;
        const sidebar = sidebarRef.current;
        if (!el || !sidebar) return;
        const r = el.getBoundingClientRect();
        const sr = sidebar.getBoundingClientRect();
        // Absoluto respecto a la barra lateral: a su lado, alineado con el
        // borde inferior del chip y abriendo hacia arriba (nunca por debajo).
        setProfilePos({ left: sr.width + 8, bottom: sr.height - (r.bottom - sr.top) });
        setProfileMsg("");
        setProfileOpen(true);
    }
    function closeProfile() {
        setProfileOpen(false);
        setProfilePos(null);
        setEditingProfileName(false);
    }
    function beginEditProfileName() {
        setProfileNameDraft(settings.userName);
        setProfileMsg("");
        setEditingProfileName(true);
    }
    function saveProfileName() {
        setSettings(current => ({ ...current, userName: profileNameDraft.trim() }));
        setEditingProfileName(false);
    }
    function exportState() {
        const payload: PersistedState = {
            version: 1,
            activeSpaceId,
            spaces,
            history,
            favorites,
            sidebarOpen,
            settings,
            note,
        };
        const json = JSON.stringify(payload, null, 2);
        navigator.clipboard.writeText(json)
            .then(() => setProfileMsg("Perfil copiado (JSON) al portapapeles."))
            .catch(() => setProfileMsg("No se pudo copiar. Revisa los permisos del portapapeles."));
    }

    // Mantiene un webview nativo por pestaña y muestra u oculta el de la pestaña activa.
    useEffect(() => {
        let cancelled = false;

        async function sync() {
            // Pruning: cierra webviews de pestañas que ya no existen en ningún espacio.
            const ids = new Set<number>();
            for (const s of spacesRef.current) for (const t of s.tabs) ids.add(t.id);
            for (const [id, entry] of webviews.current) {
                if (!ids.has(id)) {
                    webviews.current.delete(id);
                    creating.current.delete(id);
                    entry.ready.then(() => entry.wv.close().catch(() => {})).catch(() => {});
                }
            }

            const sp = spacesRef.current.find(s => s.id === activeSpaceId);
            const active = sp?.tabs.find(t => t.id === sp.activeTabId) ?? null;

            if (view !== "tab" || !active || !/^https?:/.test(active.url)) {
                setLoading(false);
                for (const { wv } of webviews.current.values()) wv.hide().catch(() => {});
                return;
            }

            for (const [id, entry] of webviews.current) {
                if (id !== active.id) entry.wv.hide().catch(() => {});
            }

            const entry = await ensureWebview(active);
            if (!entry) return;

            syncBounds(true);
            await entry.ready;
            if (cancelled) return;
            await entry.wv.show().catch(() => {});
            await entry.wv.setFocus().catch(() => {});
            lastActivatedRef.current.set(active.id, Date.now());
        }

        void sync();
        return () => { cancelled = true; };
    }, [activeTabId, activeSpaceId, view, spaces]);

    // Vigila la URL real del webview activo. Los eventos `kata://navigation`
    // cubren navegaciones clásicas, pero no las SPA puras (pushState/hash) ni
    // los estados posteriores a un crash; este poller consulta `webview_url`
    // (lado Rust, el proceso UI pregunta a WebKit) y lo refleja en la pestaña
    // y en la barra (sin pisar la barra mientras el usuario escribe). Ignora
    // `about:blank` para no propagar el parpadeo de carga ni el estado muerto
    // de una pestaña crasheada.
    useEffect(() => {
        if (view !== "tab") return;
        let disposed = false;
        let lastUrl = activePage?.url ?? "";
        const tick = async () => {
            if (disposed) return;
            const id = activeTabRef.current;
            try {
                const u = await invoke<string>("webview_url", { label: labelFor(id) });
                if (!u || u === lastUrl) return;
                if (!/^https?:/.test(u)) return;
                lastUrl = u;
                const sp = spacesRef.current.find(s => s.id === activeSpaceIdRef.current);
                const tab = sp?.tabs.find(t => t.id === id);
                if (!sp || !tab || tab.url === u) return;
                patchSpace(sp.id, { tabs: sp.tabs.map(t => (t.id === id ? { ...t, url: u, domain: hostOf(u) } : t)) });
                recordHistory(u, tab.title);
                if (!typingRef.current) setAddress(u);
            } catch { /* webview cerrado o suspendido */ }
        };
        void tick();
        const timer = window.setInterval(tick, 1000);
        return () => { disposed = true; window.clearInterval(timer); };
    }, [activeTabId, view]);

    // Mantiene la posición y el tamaño del webview alineados con el cuerpo de la pestaña.
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const observer = new ResizeObserver(() => syncBounds());
        observer.observe(host);

        const handleResize = () => syncBounds(true);
        window.addEventListener("resize", handleResize);

        let timer: number | undefined;
        const schedule = () => {
            clearTimeout(timer);
            timer = window.setTimeout(() => syncBounds(), 30);
        };
        const observerBody = new MutationObserver(schedule);
        observerBody.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "style"],
        });
        document.fonts?.ready?.then(() => syncBounds()).catch(() => {});

        let unlistenScale: UnlistenFn | null = null;
        let disposed = false;
        getCurrentWindow()
            .onScaleChanged(() => syncBounds(true))
            .then(fn => { if (disposed) fn(); else unlistenScale = fn; })
            .catch(err => console.error("no se pudo escuchar el cambio de escala", err));

        syncBounds(true);
        return () => {
            disposed = true;
            clearTimeout(timer);
            unlistenScale?.();
            observer.disconnect();
            observerBody.disconnect();
            window.removeEventListener("resize", handleResize);
        };
    }, [sidebarOpen, view, booted, activeSpaceId]);

    // ------------------------------------------------------------------

    const spaceDot = (i: number) => (i % 3 === 0 ? "" : `dot-${i % 3}`);

    const greeting = nowTick.getHours() < 12 ? "Buenos días" : nowTick.getHours() < 19 ? "Buenas tardes" : "Buenas noches";
    const greetingDate = nowTick.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    const hh = `${nowTick.getHours()}`.padStart(2, "0");
    const mm = `${nowTick.getMinutes()}`.padStart(2, "0");
    const ss = `${nowTick.getSeconds()}`.padStart(2, "0");
    const noteWords = note ? note.trim().split(/\s+/).filter(Boolean).length : 0;

    const homeViewClass = wallpaper ? "page-view home-view has-wallpaper" : "page-view home-view";

    const homeView = (
        <div className={homeViewClass} style={wallpaper ? {
            backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.42), rgba(0, 0, 0, 0.36)), url("${wallpaper}")`,
            backgroundSize: "cover",
            backgroundPosition: "center",
        } : undefined}>
            <div className="welcome-row">
                <div>
                    <div className="kicker"><span className="pulse" />{activeSpace?.name ?? "Personal"} · {greetingDate}</div>
                    <h1>{greeting},{" "}
                        {editingName ? (
                            <input autoFocus className="user-name-input" value={nameDraft}
                                onChange={event => setNameDraft(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === "Enter") saveUserName();
                                    if (event.key === "Escape") {
                                        cancelNameRef.current = true;
                                        setEditingName(false);
                                    }
                                }}
                                onBlur={commitUserName}
                                placeholder="tu nombre" />
                        ) : (
                            <button className={`user-name${settings.userName ? "" : " ghost"}`} onClick={startEditName} title="Clic para cambiar tu nombre">
                                {settings.userName || "tu nombre"}
                            </button>
                        )}<span className="accent">.</span>
                    </h1>
                    <p className="subhead">Un lugar tranquilo para empezar a pensar.</p>
                </div>
            </div>
            <div className="content-grid">
                <section className="widget-card clock-card">
                    <span className="widget-title">Reloj</span>
                    <div className="clock-time">{hh}:{mm}<span className="clock-sec">{ss}</span></div>
                    <span className="widget-sub">{nowTick.toLocaleTimeString("es-ES", { hour: "numeric", minute: "2-digit", hour12: true })} · en tu dispositivo</span>
                </section>
                <section className="widget-card date-card">
                    <span className="widget-title">Fecha</span>
                    <div className="date-full">{greetingDate}</div>
                    <span className="widget-sub">{nowTick.getFullYear()} · semana {isoWeek(nowTick)} del año</span>
                </section>
                <section className="recent-card">
                    <div className="card-topline"><span className="section-label">Accesos rápidos</span><button className="text-link" onClick={() => setView("history")} disabled={history.length === 0}>Ver todo →</button></div>
                    {history.length === 0 ? (
                        <p className="list-empty">Tus visitas recientes aparecerán aquí.</p>
                    ) : (
                        <div className="recent-list">
                            {history.slice(0, 6).map(h => (
                                <button key={h.id} title={`${h.url} — Ctrl+clic abre en pestaña nueva`} onClick={e => ((e.ctrlKey || e.metaKey) ? openInNewTab(h.url, h.title) : openEntry(h.url, h.title))}>
                                    <span className={`recent-thumb ${h.id % 2 ? "thumb-two" : ""}`}>{hostOf(h.url).charAt(0).toUpperCase()}</span>
                                    <span><strong>{h.title}</strong><small>{hostOf(h.url)} · {fmtWhen(h.visitedAt)}</small></span>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
                <section className="note-card">
                    <div className="card-topline"><span className="section-label">Notas</span><span className="note-date">{noteWords ? `${noteWords} ${noteWords === 1 ? "palabra" : "palabras"}` : "Guardado automático"}</span></div>
                    <textarea placeholder="¿Qué tienes en mente?" value={note} onChange={event => setNote(event.target.value)} />
                    <div className="note-footer"><span>Nota guardada en tu dispositivo</span><button onClick={clearNote} disabled={!note}>Borrar</button></div>
                </section>
                <section className="widget-card favorites-card">
                    <div className="card-topline"><span className="section-label">Favoritos</span><button className="text-link" onClick={() => setView("favorites")} disabled={favorites.length === 0}>Ver todos →</button></div>
                    {favorites.length === 0 ? (
                        <p className="list-empty">Guarda páginas con ☆ para tenerlas aquí.</p>
                    ) : (
                        <div className="favorite-tiles">
                            {favorites.slice(0, 6).map(f => (
                                <button key={f.id} className="favorite-tile" title={`${f.url} — Ctrl+clic abre en pestaña nueva`} onClick={e => ((e.ctrlKey || e.metaKey) ? openInNewTab(f.url, f.title) : openEntry(f.url, f.title))}>
                                    <span className="entry-icon">{hostOf(f.url).charAt(0).toUpperCase()}</span>
                                    <span className="favorite-name">{f.title}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
            </div>
            <footer className="page-footer"><span>kata 0.1 <i /> Privacidad primero</span><span>Ctrl+K no existe todavía · tus datos, en tu dispositivo</span></footer>
        </div>
    );

    // Pase de bienvenida (primer arranque): perfil, tema, fondo y contactos.
    const welcomeView = (
        <div className="page-view list-view welcome-view">
            <div className="list-header">
                <div>
                    <div className="kicker"><span className="pulse" />Primeros pasos</div>
                    <h1>Bienvenido a kata<span className="accent">.</span></h1>
                    <p className="subhead">Configura tu navegador en un minuto. Todo queda guardado en tu dispositivo.</p>
                </div>
            </div>

            <section className="settings-card">
                <div className="settings-caption">Tu perfil</div>
                <div className="setting-row">
                    <div className="setting-copy">
                        <strong>Cómo te llamas</strong>
                        <small>Se usa para saludarte en el Inicio. Puedes dejarlo vacío o cambiarlo cuando quieras.</small>
                    </div>
                    <input className="setting-input" value={settings.userName} onChange={event => setSettings(current => ({ ...current, userName: event.target.value }))} placeholder="tu nombre" maxLength={40} aria-label="Tu nombre" />
                </div>
                <div className="setting-row column">
                    <div className="setting-copy">
                        <strong>Tema preferido</strong>
                        <small>Se aplica al instante y podrás cambiarlo en Preferencias.</small>
                    </div>
                    <div className="theme-picker" role="group" aria-label="Tema de la interfaz">
                        {THEMES.map(t => (
                            <button key={t.id} className={settings.theme === t.id ? "active" : ""} onClick={() => setTheme(t.id)} title={`Tema ${t.name}`}>
                                <span className={`swatch ${t.id}`} />{t.name}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="setting-row column">
                    <div className="setting-copy">
                        <strong>Fondo de inicio</strong>
                        <small>Una imagen propia como fondo del Inicio. Se guarda en tu dispositivo.</small>
                    </div>
                    <div className="wallpaper-row">
                        {wallpaper && <div className="wallpaper-preview" style={{ backgroundImage: `url("${wallpaper}")` }} />}
                        <div className="wallpaper-buttons">
                            <input ref={wallpaperInputRef} className="hidden-file" type="file" accept="image/*" onChange={onPickWallpaper} />
                            <button className="focus-button" onClick={pickWallpaper}>Elegir imagen…</button>
                            {wallpaper && <button className="danger-button" onClick={removeWallpaper}>Quitar imagen</button>}
                        </div>
                    </div>
                </div>
            </section>

            <section className="settings-card">
                <div className="settings-caption">Mis contactos</div>
                <p className="settings-hint">Así puedes contactar al desarrollador de kata. Quedan guardados en tu dispositivo.</p>
                <div className="contact-grid">
                    {CONTACTS.map(c => (
                        <button
                            key={c.id}
                            className="contact-card"
                            onClick={() => openContact(c)}
                            title={c.kind === "copy" ? `Copiar ${c.label.toLowerCase()} al portapapeles` : `Abrir ${c.label} en una pestaña nueva`}
                        >
                            <span className={`contact-avatar ${c.tone}`}>{c.icon}</span>
                            <span className="contact-text">
                                <span className="contact-name">{c.label}</span>
                                <span className={`contact-role${contactCopied === c.label ? " copied" : ""}`}>{contactCopied === c.label ? "¡Copiado!" : c.value}</span>
                            </span>
                        </button>
                    ))}
                </div>
            </section>

            <div className="welcome-actions">
                <button className="focus-button welcome-start" onClick={completeOnboarding}>Empezar a navegar →</button>
                <span className="welcome-note">Los ajustes se guardan en tu dispositivo.</span>
            </div>
        </div>
    );

    const historyView = (
        <div className="page-view list-view">
            <div className="list-header">
                <div>
                    <div className="kicker"><span className="pulse" />Historial</div>
                    <h1>Lo que has visitado<span className="accent">.</span></h1>
                    <p className="subhead">Guarda las navegaciones localmente en tu dispositivo.</p>
                </div>
                <button className="focus-button" disabled={history.length === 0} onClick={clearHistory}>Borrar todo</button>
            </div>
            {history.length === 0 ? (
                <p className="list-empty">Aún no hay entradas. Al navegar, aparecerán aquí.</p>
            ) : (
                <ul className="entry-list">
                    {history.map(h => (
                        <li key={h.id}>
                            <button className="entry-main" title={`${h.url} — Ctrl+clic abre en pestaña nueva`} onClick={e => ((e.ctrlKey || e.metaKey) ? openInNewTab(h.url, h.title) : openEntry(h.url, h.title))}>
                                <span className="entry-icon">{hostOf(h.url).charAt(0).toUpperCase()}</span>
                                <span className="entry-text"><strong>{h.title}</strong><small>{h.url}</small></span>
                                <span className="entry-time">{fmtWhen(h.visitedAt)}</span>
                            </button>
                            <button className="entry-remove" title="Quitar del historial" onClick={() => setHistory(current => current.filter(x => x.id !== h.id))}>×</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );

    const favoritesView = (
        <div className="page-view list-view">
            <div className="list-header">
                <div>
                    <div className="kicker"><span className="pulse" />Favoritos</div>
                    <h1>Tus páginas guardadas<span className="accent">.</span></h1>
                    <p className="subhead">Marca con la estrella ↑ las páginas que quieras conservar.</p>
                </div>
            </div>
            {favorites.length === 0 ? (
                <p className="list-empty">Aún no hay favoritos. Usa la estrella de la barra para guardar una página.</p>
            ) : (
                <ul className="entry-list">
                    {favorites.map(f => (
                        <li key={f.id}>
                            <button className="entry-main" title={`${f.url} — Ctrl+clic abre en pestaña nueva`} onClick={e => ((e.ctrlKey || e.metaKey) ? openInNewTab(f.url, f.title) : openEntry(f.url, f.title))}>
                                <span className="entry-icon">{hostOf(f.url).charAt(0).toUpperCase()}</span>
                                <span className="entry-text"><strong>{f.title}</strong><small>{f.url} · {f.domain}</small></span>
                                <span className="entry-time">{fmtWhen(f.addedAt)}</span>
                            </button>
                            <button className="entry-remove" title="Quitar de favoritos" onClick={() => setFavorites(current => current.filter(x => x.id !== f.id))}>×</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );

    const settingsView = (
        <div className="page-view list-view">
            <div className="list-header">
                <div>
                    <div className="kicker"><span className="pulse" />Preferencias</div>
                    <h1>Ajustes del navegador<span className="accent">.</span></h1>
                    <p className="subhead">Comportamiento, rendimiento y datos.</p>
                </div>
            </div>

            <section className="settings-card">
                <div className="settings-caption">Rendimiento</div>
                <div className="setting-row">
                    <div className="setting-copy">
                        <strong>Suspensión por inactividad</strong>
                        <small>Libera el proceso de las pestañas ocultas tras un respiro para ahorrar memoria. Al volver a una pestaña suspendida, su proceso se reactiva solo al entrar.</small>
                    </div>
                    <button
                        className={`switch ${settings.suspendEnabled ? "on" : ""}`}
                        role="switch"
                        aria-checked={settings.suspendEnabled}
                        onClick={() => setSettings(current => ({ ...current, suspendEnabled: !current.suspendEnabled }))}
                    ><span className="thumb" /></button>
                </div>
                {settings.suspendEnabled && (
                    <>
                        <div className="setting-row">
                            <div className="setting-copy">
                                <strong>Respiro antes de suspender</strong>
                                <small>Tiempo que una pestaña oculta permanece activa antes de liberar su proceso.</small>
                            </div>
                            <div className="segmented" role="group" aria-label="Respiro de suspensión">
                                {[30_000, 60_000, 120_000].map(ms => (
                                    <button
                                        key={ms}
                                        className={settings.suspendAfterMs === ms ? "active" : ""}
                                        onClick={() => setSuspendDelay(ms)}
                                    >{ms === 30_000 ? "30 s" : ms === 60_000 ? "1 min" : "2 min"}</button>
                                ))}
                            </div>
                        </div>
                        <div className="setting-row column">
                            <div className="setting-copy">
                                <strong>Páginas exentas</strong>
                                <small>Estos dominios nunca se suspenden, aunque queden ocultos. Escríbelos sin «www» (ej.: youtube.com) y se aplican también a sus subdominios.</small>
                            </div>
                            <form className="exempt-form" onSubmit={addExemptDomain}>
                                <input value={exemptInput} onChange={event => setExemptInput(event.target.value)} placeholder="dominio.com" aria-label="Dominio exento" />
                                <button className="focus-button" type="submit">Añadir</button>
                            </form>
                            {settings.suspendExemptDomains.length > 0 && (
                                <div className="exempt-chips">
                                    {settings.suspendExemptDomains.map(domain => (
                                        <span key={domain} className="chip">{domain}<button title={`Quitar ${domain}`} onClick={() => removeExemptDomain(domain)}>×</button></span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </section>

            <section className="settings-card">
                <div className="settings-caption">General</div>
                <div className="setting-row">
                    <div className="setting-copy">
                        <strong>Al iniciar</strong>
                        <small>Restaura las pestañas de la última sesión, o arranca limpio con la vista de inicio.</small>
                    </div>
                    <div className="segmented" role="group" aria-label="Comportamiento al iniciar">
                        <button className={settings.startRestoreTabs ? "active" : ""} onClick={() => setStartRestore(true)}>Restaurar pestañas</button>
                        <button className={!settings.startRestoreTabs ? "active" : ""} onClick={() => setStartRestore(false)}>Empezar limpio</button>
                    </div>
                </div>
                <div className="setting-row">
                    <div className="setting-copy">
                        <strong>Buscador por defecto</strong>
                        <small>Se usa cuando escribes una búsqueda en la barra de direcciones.</small>
                    </div>
                    <select className="setting-select" value={settings.searchEngine} onChange={event => setEngine(event.target.value as Settings["searchEngine"])} aria-label="Buscador por defecto">
                        <option value="google">Google</option>
                        <option value="duckduckgo">DuckDuckGo</option>
                        <option value="bing">Bing</option>
                    </select>
                </div>
                <div className="setting-row">
                    <div className="setting-copy">
                        <strong>Tu nombre</strong>
                        <small>Aparece en el saludo del Inicio. También puedes hacer clic sobre tu nombre ahí mismo para cambiarlo.</small>
                    </div>
                    <input className="setting-input" value={settings.userName} onChange={event => setSettings(current => ({ ...current, userName: event.target.value }))} placeholder="sin nombre" maxLength={40} aria-label="Tu nombre" />
                </div>
                <div className="setting-row column">
                    <div className="setting-copy">
                        <strong>Tema</strong>
                        <small>Paleta de colores de la interfaz.</small>
                    </div>
                    <div className="theme-picker" role="group" aria-label="Tema de la interfaz">
                        {THEMES.map(t => (
                            <button key={t.id} className={settings.theme === t.id ? "active" : ""} onClick={() => setTheme(t.id)} title={`Tema ${t.name}`}>
                                <span className={`swatch ${t.id}`} />{t.name}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="setting-row column">
                    <div className="setting-copy">
                        <strong>Fondo de inicio</strong>
                        <small>Imagen de fondo del Inicio. Se guarda en tu dispositivo junto con los ajustes y permanece al cerrar y reabrir el navegador.</small>
                    </div>
                    <div className="wallpaper-row">
                        {wallpaper && <div className="wallpaper-preview" style={{ backgroundImage: `url("${wallpaper}")` }} />}
                        <div className="wallpaper-buttons">
                            <input ref={wallpaperInputRef} className="hidden-file" type="file" accept="image/*" onChange={onPickWallpaper} />
                            <button className="focus-button" onClick={pickWallpaper}>Elegir imagen…</button>
                            {wallpaper && <button className="danger-button" onClick={removeWallpaper}>Quitar imagen</button>}
                        </div>
                    </div>
                    {wallpaperMsg && <span className="wallpaper-msg">{wallpaperMsg}</span>}
                </div>
            </section>

            <section className="settings-card">
                <div className="settings-caption">Datos</div>
                <div className="setting-row">
                    <div className="setting-copy">
                        <strong>Historial</strong>
                        <small>{history.length} entradas guardadas en tu dispositivo.</small>
                    </div>
                    <button
                        className={`danger-button ${confirmClear === "history" ? "confirm" : ""}`}
                        disabled={history.length === 0}
                        onClick={() => clickClear("history")}
                    >{confirmClear === "history" ? "¿Confirmar?" : "Borrar historial"}</button>
                </div>
                <div className="setting-row">
                    <div className="setting-copy">
                        <strong>Favoritos</strong>
                        <small>{favorites.length} favoritos guardados en tu dispositivo.</small>
                    </div>
                    <button
                        className={`danger-button ${confirmClear === "favorites" ? "confirm" : ""}`}
                        disabled={favorites.length === 0}
                        onClick={() => clickClear("favorites")}
                    >{confirmClear === "favorites" ? "¿Confirmar?" : "Borrar favoritos"}</button>
                </div>
                <div className="setting-row reset-row">
                    <div className="setting-copy">
                        <strong>Restablecer kata</strong>
                        <small>Borra historial, favoritos, notas, nombre, tema, fondo y espacios. Vuelve a mostrar la bienvenida del primer uso.</small>
                    </div>
                    <button
                        className={`danger-button ${confirmReset ? "confirm" : ""}`}
                        onClick={toggleReset}
                    >{confirmReset ? "¿Seguro?" : "Restablecer"}</button>
                </div>
            </section>

            <section className="settings-card">
                <div className="settings-caption">Sobre el creador</div>
                <div className="creator-card">
                    <div className="creator-avatar">{CREATOR.name.charAt(0).toUpperCase()}</div>
                    <div className="creator-body">
                        <strong>{CREATOR.name} <span className="creator-handle">{CREATOR.handle}</span></strong>
                        <small>{CREATOR.role}</small>
                        <p>{CREATOR.bio}</p>
                        <div className="creator-links">
                            {CREATOR.links.map(l => (
                                <button
                                    key={l.label}
                                    className="chip"
                                    onClick={() => openContact(l)}
                                    title={l.kind === "copy" ? `Copiar ${l.label.toLowerCase()} al portapapeles` : `Abrir ${l.label} en una pestaña nueva`}
                                >{l.label}<i />{contactCopied === l.label ? "¡Copiado!" : l.value}</button>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            <footer className="page-footer"><span>kata 0.1 <i /> Privacidad primero</span><span>Los ajustes se guardan en tu dispositivo</span></footer>
        </div>
    );

    function renderBody() {
        if (!booted) {
            return (
                <div className="boot">
                    <div className="kicker"><span className="pulse" />k a t a</div>
                </div>
            );
        }
        if (view === "welcome") return welcomeView;
        if (view === "home") return homeView;
        if (view === "history") return historyView;
        if (view === "favorites") return favoritesView;
        if (view === "settings") return settingsView;
        if (!activePage?.url) {
            return (
                <div className="page-view empty-tab">
                    <div className="welcome-row">
                        <div>
                            <div className="kicker"><span className="pulse" />{activeSpace?.name ?? ""} · nueva pestaña</div>
                            <h1>Página en blanco<span className="accent">.</span></h1>
                            <p className="subhead">Escribe una dirección en la barra para empezar.</p>
                        </div>
                    </div>
                    <footer className="page-footer"><span>kata 0.1 <i /> Privacidad primero</span></footer>
                </div>
            );
        }
        return <div className="tab-body" ref={hostRef}>{loading && <div className="native-page-loading"><span className="pulse" />Cargando {activePage?.domain}</div>}</div>;
    }

    return (
        <main className="browser-shell">
            <section className="browser-frame">
                <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
                    <div className="sidebar-top"><button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} title="Alternar barra lateral">◀</button>{sidebarOpen && <span className="eyebrow">Tu espacio</span>}</div>
                    <nav className="side-nav" aria-label="Navegación principal">
                        <button className={`nav-item ${view === "home" ? "active" : ""}`} onClick={() => setView("home")}><span className="nav-icon">⌂</span>{sidebarOpen && <span>Inicio</span>}</button>
                        <button className={`nav-item ${view === "favorites" ? "active" : ""}`} onClick={() => setView("favorites")}><span className="nav-icon">◒</span>{sidebarOpen && <span>Favoritos</span>}<span className="nav-count">{favorites.length}</span></button>
                        <button className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><span className="nav-icon">◫</span>{sidebarOpen && <span>Historial</span>}</button>
                    </nav>
                    {sidebarOpen && <div className="side-section-label">Espacios <button className="new-space" onClick={createSpace} title="Nuevo espacio">+</button></div>}
                    <div className="space-list">
                        {spaces.map((s, index) => (
                            <div key={s.id} className={`space-row ${activeSpaceId === s.id ? "selected" : ""}`}>
                                {renamingId === s.id ? (
                                    <input
                                        className="space-rename"
                                        autoFocus
                                        value={renamingName}
                                        onChange={event => setRenamingName(event.target.value)}
                                        onBlur={commitRename}
                                        onKeyDown={event => {
                                            if (event.key === "Enter") commitRename();
                                            else if (event.key === "Escape") setRenamingId(null);
                                        }}
                                    />
                                ) : (
                                    <button className="space-item" title={sidebarOpen ? undefined : s.name} onClick={() => switchSpace(s.id)}>
                                        <span className={`space-dot ${spaceDot(index)}`} /><span className="space-name">{s.name}{s.priv && <span className="space-lock" title="Espacio privado: no guarda historial">🔒</span>}</span>
                                    </button>
                                )}
                                {sidebarOpen && renamingId !== s.id && (
                                    <div className="space-actions">
                                        <button
                                            className="space-tabs-btn"
                                            title="Ver pestañas de este espacio"
                                            aria-label={`Ver pestañas de ${s.name}`}
                                            onPointerDown={event => event.stopPropagation()}
                                            onClick={event => toggleTabsMenu(s.id, (event.currentTarget.closest(".space-row") as HTMLElement | null) ?? event.currentTarget)}
                                        >◫</button>
                                        <button
                                            className="space-more"
                                            title="Opciones de espacio"
                                            aria-label={`Opciones de ${s.name}`}
                                            onPointerDown={event => event.stopPropagation()}
                                            onClick={event => toggleMenu(s.id, (event.currentTarget.closest(".space-row") as HTMLElement | null) ?? event.currentTarget)}
                                        >···</button>
                                    </div>
                                )}
                                {sidebarOpen && tabsMenuFor === s.id && tabsMenuPos && (
                                    <div className="space-tabs-menu" style={{ left: tabsMenuPos.x, top: tabsMenuPos.y, width: 220 }} role="menu" aria-label={`Pestañas de ${s.name}`}>
                                        <div className="space-tabs-head">{s.name} <span>· {s.tabs.length} {s.tabs.length === 1 ? "pestaña" : "pestañas"}</span></div>
                                        {s.tabs.length === 0 && <div className="space-tabs-empty">Sin pestañas todavía</div>}
                                        {s.tabs.map(t => (
                                            <button key={t.id} className="space-tab-item" role="menuitem" onClick={() => openTabInSpace(s.id, t.id)}>
                                                <span className={`tab-dot ${t.tone}`} /><span className="space-tab-title">{t.title || "Nueva pestaña"}</span>
                                            </button>
                                        ))}
                                        <button className="space-tab-item new" role="menuitem" onClick={() => newTabInSpace(s.id)}>
                                            <span className="tab-dot cream" /><span className="space-tab-title">Nueva pestaña</span>
                                        </button>
                                    </div>
                                )}
                                {sidebarOpen && menuId === s.id && menuPos && (
                                    <div className="space-menu" style={{ right: menuPos.right, top: menuPos.top }}>
                                        <button onClick={() => togglePrivate(s.id)}>{s.priv ? "✓ " : ""}Espacio privado</button>
                                        <button onClick={() => beginRename(s.id)}>Renombrar</button>
                                        <button className="danger" onClick={() => beginClose(s.id)} disabled={spaces.length <= 1}>{confirmingId === s.id ? "¿Seguro?" : "Cerrar espacio"}</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    <div className="sidebar-bottom">
                        <button className={`nav-item ${view === "settings" ? "active" : ""}`} onClick={() => setView("settings")}><span className="nav-icon">⚙</span>{sidebarOpen && <span>Preferencias</span>}</button>
                        {sidebarOpen && (
                            <>
                                <button ref={profileChipRef} className="profile-chip" onClick={toggleProfile} onPointerDown={event => event.stopPropagation()} title="Menú de perfil">
                                    <div className="avatar">{(settings.userName || "?").charAt(0).toUpperCase()}</div>
                                    <div><strong>{settings.userName || "sin nombre"}</strong><small>Perfil local · sin sincronizar</small></div>
                                    <span className={`profile-caret${profileOpen ? " open" : ""}`}>⌄</span>
                                </button>
                                {profileOpen && profilePos && (
                                    <div className="profile-pop" style={{ left: profilePos.left, bottom: profilePos.bottom }} role="menu" aria-label="Perfil">
                                        <div className="pop-header">
                                            <div className="avatar">{(settings.userName || "?").charAt(0).toUpperCase()}</div>
                                            <div><strong>{settings.userName || "sin nombre"}</strong><small>Perfil local · datos en tu dispositivo</small></div>
                                        </div>
                                        {editingProfileName ? (
                                            <div className="pop-edit-name">
                                                <input autoFocus value={profileNameDraft} placeholder="tu nombre" maxLength={40}
                                                    onChange={event => setProfileNameDraft(event.target.value)}
                                                    onKeyDown={event => {
                                                        if (event.key === "Enter") saveProfileName();
                                                        if (event.key === "Escape") closeProfile();
                                                    }} />
                                                <button className="focus-button" onClick={saveProfileName}>Guardar</button>
                                            </div>
                                        ) : (
                                            <button className="pop-item" role="menuitem" onClick={beginEditProfileName}>Cambiar tu nombre</button>
                                        )}
                                        <button className="pop-item" role="menuitem" onClick={() => { closeProfile(); setView("settings"); }}>Preferencias</button>
                                        <button className="pop-item" role="menuitem" onClick={exportState}>Exportar estado (JSON) al portapapeles</button>
                                        {profileMsg && <div className="pop-msg">{profileMsg}</div>}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </aside>
                <div className="browser-content">
                    <div className="tab-strip">
                        <div className="tabs">
                            {activeSpace?.tabs.map(tab => (
                                <button key={tab.id} className={`tab ${activeTabId === tab.id ? "current" : ""}`} onClick={() => selectTab(tab.id)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }} title="Clic central: cerrar pestaña">
                                    <span className={`tab-dot ${tab.tone}`} /><span className="tab-title">{tab.title}</span>
                                    <span className="tab-close" onClick={event => { event.stopPropagation(); closeTab(tab.id); }}>×</span>
                                </button>
                            ))}
                            <button className="new-tab" onClick={createTab} title="Nueva pestaña">+</button>
                        </div>
                        <button className="icon-button more-button" title="Más opciones">···</button>
                    </div>
                    <div className="toolbar">
                        <div className="browser-controls">
                            <button className="round-control" title="Atrás" onClick={() => toolbarAction("back")}>‹</button>
                            <button className="round-control muted" title="Adelante" onClick={() => toolbarAction("forward")}>›</button>
                            <button className="round-control" title="Recargar" onClick={() => toolbarAction("reload")}>↻</button>
                        </div>
                        <div className="address-wrap">
                            <form className="address-bar" onSubmit={navigate}>
                                <span className="lock">⌁</span>
                                <input ref={addressRef} value={address}
                                    onChange={event => {
                                        setAddress(event.target.value);
                                        setSuggestOpen(true);
                                        suggestTouchedRef.current = false;
                                        setSuggestIdx(0);
                                    }}
                                    onFocus={() => { typingRef.current = true; if (address.trim()) setSuggestOpen(true); }}
                                    onBlur={() => { typingRef.current = false; setSuggestOpen(false); }}
                                    onKeyDown={event => {
                                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                            event.preventDefault();
                                            if (!suggestOpen) { setSuggestOpen(true); return; }
                                            if (suggestions.length === 0) return;
                                            suggestTouchedRef.current = true;
                                            setSuggestIdx(i => event.key === "ArrowDown"
                                                ? Math.min(i + 1, suggestions.length - 1)
                                                : Math.max(i - 1, 0));
                                        } else if (event.key === "Escape") {
                                            if (suggestOpen) {
                                                event.preventDefault();
                                                setSuggestOpen(false);
                                                suggestTouchedRef.current = false;
                                            }
                                        } else if (event.key === "Enter") {
                                            if (suggestOpen && suggestTouchedRef.current && suggestions[suggestIdx]) {
                                                event.preventDefault();
                                                openSuggestion(suggestions[suggestIdx]);
                                            }
                                        }
                                    }}
                                    placeholder={activePage?.domain ?? "Buscar o escribir una dirección"} aria-label="Dirección" />
                                <button className="address-action" type="submit" title="Ir">↵</button>
                            </form>
                            {suggestOpen && suggestions.length > 0 && (
                                <div className="suggest-panel" role="listbox" aria-label="Sugerencias">
                                    {suggestions.map((sg, i) => (
                                        <button key={`${sg.kind}-${sg.url}`} type="button"
                                            className={`suggest-row${i === suggestIdx ? " active" : ""}`}
                                            role="option" aria-selected={i === suggestIdx}
                                            onMouseDown={event => event.preventDefault()}
                                            onClick={() => openSuggestion(sg)}>
                                            <span className={`suggest-icon ${sg.kind}`}>{sg.kind === "buscar" ? "⌕" : sg.kind === "favorito" ? "★" : "↻"}</span>
                                            <span className="suggest-main"><strong>{sg.title}</strong><small>{sg.sub}</small></span>
                                            <span className="suggest-go">↵</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button className={`save-button ${isFavorited ? "is-saved" : ""}`} onClick={toggleFavorite} title={isFavorited ? "Quitar de favoritos" : "Guardar en favoritos"}>{isFavorited ? "★" : "☆"}</button>
                    </div>
                    {renderBody()}
                </div>
            </section>
            {switcherOpen && (
                <div className="switcher-backdrop" onClick={() => setSwitcherOpen(false)}>
                    <div className="switcher-panel" role="dialog" aria-label="Cambiar de pestaña o espacio" onClick={event => event.stopPropagation()}>
                        <div className="switcher-input-row">
                            <span className="switcher-kbd">Ctrl+P</span>
                            <input ref={switcherInputRef} value={switcherQuery}
                                onChange={event => { setSwitcherQuery(event.target.value); setSwitcherIdx(0); }}
                                placeholder="Pestañas y espacios…" aria-label="Buscar pestaña o espacio" />
                        </div>
                        <div className="switcher-list">
                            {switcherItems.length === 0 ? (
                                <div className="switcher-empty">Sin resultados</div>
                            ) : switcherItems.map((item, i) => (
                                <button key={item.type === "tab" ? `t-${item.tabId}` : `s-${item.spaceId}`} type="button"
                                    className={`switcher-row${i === switcherIdx ? " active" : ""}`}
                                    onMouseDown={event => event.preventDefault()}
                                    onClick={() => activateSwitcherItem(item)}>
                                    {item.type === "space"
                                        ? <span className="switcher-icon space">▦</span>
                                        : <span className="switcher-icon tab">▤</span>}
                                    <span className="switcher-main">
                                        <strong>{item.type === "space" ? item.name : item.title}</strong>
                                        <small>{item.type === "space"
                                            ? `${item.tabs} ${item.tabs === 1 ? "pestaña" : "pestañas"}`
                                            : `${item.spaceName} · ${item.url || "Inicio"}${item.priv ? " 🔒" : ""}`}</small>
                                    </span>
                                    <span className="switcher-kbd">↵</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}

export default App;
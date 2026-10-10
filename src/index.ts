/**
 * API pública de los plugins de Hebra, versión 1 (`docs/SPEC-PLUGINS-EXTERNOS.md` §5,
 * tarea de Lumbre `44b44a5b`). Este fichero es la FUENTE de los tipos: Hebra los
 * reexporta (`src/lib/plugins/api/types.ts`) y su fachada (`createPluginApi`) se compila
 * contra ellos, así que una fachada que no cumpla el contrato no compila (§5.4, «test de
 * contrato»). Un plugin lo instala como dependencia de desarrollo y solo importa de aquí
 * tipos y dos utilidades sin estado (`isPluginApiError`, las listas de constantes).
 *
 * Nada de este fichero importa Hebra: el paquete se copia tal cual a un repo público.
 * La única dependencia es de TIPOS, `@codemirror/state` (`Extension`), que un plugin con
 * extensiones de editor ya tiene; en ejecución, CodeMirror lo presta Hebra (§6, `./shared`).
 *
 * Versionado (§5.4): MAYOR = algo se quita o cambia de significado; MENOR = algo se
 * añade; PARCHE = arreglo sin cambio de forma. `PLUGIN_API_VERSION` es la versión que
 * describen estos tipos; la que implementa Hebra llega en `api.apiVersion`.
 */
import type { Extension } from '@codemirror/state';

/** Versión de la API que describen estos tipos (la del paquete). */
export const PLUGIN_API_VERSION = '1.4.0';

// ---- Plataforma y capacidades (§5.3, §7) ----

export const PLUGIN_PLATFORMS = ['macos', 'ios', 'linux', 'windows', 'android', 'web'] as const;
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

/**
 * Lo que un plugin declara en `hebra.json` (`capabilities.required`/`optional`) y lo que
 * pregunta `api.has()`. `ui`, `env`, `storage`, `markdown` y `workspace` están SIEMPRE.
 * `workspace` sigue en esta lista solo para que `api.has('workspace')` compile (y dé
 * `true`) y para que un `hebra.json` que lo declare siga siendo válido: Hebra lo acepta y
 * lo ignora, no hace falta declararlo. El resto, sin declarar, rechaza con
 * `capability-not-declared`.
 */
export const PLUGIN_CAPABILITIES = [
  'vault.read',
  'vault.write',
  'workspace',
  'editor',
  'http',
  'secrets',
  'tcp',
  'notify.system',
  'background'
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/**
 * Desde la 1.3. Lo que el ANFITRIÓN sabe hacer, que también se pregunta con `api.has()`.
 * No son permisos: no se declaran en `hebra.json` (un Hebra anterior daría por incompatible
 * un plugin que las pusiera en `capabilities.required`) y no salen en la hoja de
 * consentimiento. Un Hebra que no conoce un nombre responde `false` sin lanzar, así que
 * `api.has('ui.view.main')` es la forma de degradar sin comparar versiones.
 *
 * - `ui.view.main`: `placement: 'main'`, `ui.updateView`, `ui.updateViewSection` y la
 *   opción `section` de `ui.revealView` (`PluginMainViewDefinition`).
 * - `markdown.image.remote` (desde la 1.4): una imagen Markdown con destino `https`,
 *   `![alt](https://…)`, se pinta EN LÍNEA en la nota, también en una línea de lista y en
 *   una celda de tabla. Tamaño con la sintaxis de Obsidian, `![alt|24](…)` (ancho en px)
 *   o `![alt|24x24](…)`; dentro de una tabla la barra va escapada, `![alt\|24](…)`. Un
 *   Hebra anterior enseña el texto alternativo (con el `|24` a la vista) en vez de la
 *   imagen, así que un plugin que escribe iconos en las notas pregunta antes. El usuario
 *   puede apagar la carga («Cargar imágenes remotas»): `has()` sigue dando `true` y la
 *   nota enseña el alternativo, ya sin el `|24`.
 */
export const PLUGIN_HOST_FEATURES = ['ui.view.main', 'markdown.image.remote'] as const;
export type PluginHostFeature = (typeof PLUGIN_HOST_FEATURES)[number];

// ---- Errores ----

/**
 * Códigos con los que rechaza (o lanza) la API. Un plugin los distingue con
 * `isPluginApiError(error, code)`, nunca con `instanceof`: la clase vive en el paquete
 * de Hebra, no en el del plugin.
 *
 * - `capability-not-declared`: el plugin no la puso en `hebra.json`.
 * - `unavailable-on-platform`: declarada, pero esta plataforma no la tiene (TCP en
 *   iPhone, §7). No se llega a invocar nada nativo.
 * - `capability-not-available`: declarada, pero esta versión de Hebra todavía no la
 *   implementa en ninguna plataforma (hoy, ninguna).
 * - `host-not-declared`: `http.request` a un host que no está en `network.hosts` ni lo
 *   ha aceptado el usuario (`http.requestUserHost`), o `requestUserHost` sin
 *   `network.userHosts: true` en `hebra.json` (§8.4).
 * - `extension-rechazada`: la extensión de CodeMirror no se puede montar (otra copia de
 *   `@codemirror/state`, valor que no es extensión, §6).
 * - `note-locked`: escritura sobre una nota protegida (§8.5): nunca se toca.
 * - `invalid-argument`: argumento con forma inválida (URL, id vacío…).
 * - `plugin-disposed`: llamada a un registro después de apagar el plugin.
 */
export const PLUGIN_API_ERROR_CODES = [
  'capability-not-declared',
  'unavailable-on-platform',
  'capability-not-available',
  'host-not-declared',
  'extension-rechazada',
  'note-locked',
  'invalid-argument',
  'plugin-disposed'
] as const;
export type PluginApiErrorCode = (typeof PLUGIN_API_ERROR_CODES)[number];

/** La forma de un error de la API, sea de la clase de Hebra o serializado. */
export interface PluginApiErrorShape {
  readonly name: 'PluginApiError';
  readonly code: PluginApiErrorCode;
  readonly message: string;
}

/** `true` si `error` es un error de la API (y, con `code`, de ese código). */
export function isPluginApiError(
  error: unknown,
  code?: PluginApiErrorCode
): error is PluginApiErrorShape {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== 'PluginApiError') return false;
  if (!(PLUGIN_API_ERROR_CODES as readonly unknown[]).includes(candidate.code)) return false;
  return code === undefined || candidate.code === code;
}

// ---- Módulo del plugin ----

export type PluginCleanup = () => void | Promise<void>;
export type PluginUnregister = () => void;

/** Lo que exporta `hebra-main.mjs` (§3.1). */
export interface HebraPluginModule {
  activate(api: HebraPluginApi): void | PluginCleanup | Promise<void | PluginCleanup>;
}

// ---- ui: el ModuleHost de Hebra sin lo que pasa a otras fachadas (§5.1) ----

/** Limpieza opcional que un `mount(el)` puede devolver. */
export type PluginMountFn = (el: HTMLElement) => void | (() => void);

/**
 * `'column'` = pestaña del inspector (hoja en iPhone); `'dialog'` = diálogo ancho. La
 * pantalla principal (`'main'`, desde la 1.3) tiene su propia definición:
 * `PluginMainViewDefinition`.
 */
export type PluginViewPlacement = 'column' | 'dialog';

export interface PluginViewDefinition {
  id: string;
  title: string;
  /** Nombre Lucide. */
  icon: string;
  placement?: PluginViewPlacement;
  mount(el: HTMLElement): void;
  unmount(): void;
}

/**
 * Desde la 1.3. Una sección de una vista `'main'`: una fila de la lista que Hebra pinta en
 * la columna central (el plugin no dibuja esa lista). Añadir o quitar secciones exige
 * registrar la vista otra vez; lo demás se cambia en vivo con `ui.updateViewSection`.
 *
 * Se puede desregistrar y registrar el MISMO `id` en el mismo momento con la vista abierta:
 * la pantalla principal no se cierra y Hebra vuelve a montar la sección que se veía (la
 * primera, si ya no existe). Todo lo montado antes se desmonta, también lo retenido.
 */
export interface PluginViewSection {
  /** Único dentro de la vista. Es el `sectionId` que recibe `mountSection`. */
  id: string;
  /** Texto de la fila. */
  title: string;
  /** Nombre Lucide; sin él, la fila va sin icono. */
  icon?: string;
  /** Segunda línea de la fila, en gris. */
  subtitle?: string;
  /** Aviso a la derecha de la fila (un recuento, «Nuevo»). `null`, `0` y `''` no pintan
   *  nada. Hebra lo corta con puntos suspensivos si no cabe. */
  badge?: string | number | null;
}

/**
 * Desde la 1.3. Lo que `mountSection` puede devolver para enterarse de lo que pasa después
 * con esa sección. Las dos funciones son opcionales y, si lanzan, Hebra lo anota con el id
 * del plugin y sigue.
 */
export interface PluginViewSectionMount {
  /** Hebra la llama UNA vez, al desmontar la sección: suelta aquí lo que montaste. */
  unmount?(): void;
  /**
   * Solo con `retainSections: true`. La sección deja de verse (`false`: el usuario elige
   * otra sección, sale de la vista o, en un iPhone, vuelve a la lista de secciones) o
   * vuelve a verse (`true`). Recién montada está visible y no se avisa; tampoco se avisa
   * antes de `unmount`. Sirve para parar y reanudar lo que solo tiene sentido a la vista
   * (un temporizador, un sondeo).
   *
   * Medidas: `true` llega DESPUÉS de que el elemento vuelva a tener tamaño, así que mide
   * al recibir `true`. No midas al recibir `false`: Hebra no garantiza que el elemento
   * conserve su tamaño en ese momento. Oculto, el elemento sigue en el documento y en el
   * mismo nodo, bajo `hidden` (`display: none`): todas sus medidas son 0 y sus
   * `ResizeObserver` y consultas `@container` no dan nada útil.
   */
  onVisibilityChange?(visible: boolean): void;
}

/**
 * Desde la 1.3. Una vista en la PANTALLA PRINCIPAL. Solo existe si
 * `api.has('ui.view.main')`; en un Hebra anterior hay que registrar vistas `'column'` o
 * `'dialog'` (ver «Compatibilidad»).
 *
 * La barra lateral izquierda no cambia. La columna central pasa a ser el título de la
 * vista y la lista de `sections`, que pinta Hebra con el aspecto de su lista de notas. La
 * columna de contenido es del plugin: `mountSection(el, sectionId)` dibuja en `el` la
 * sección elegida.
 *
 * **Montaje.** `mountSection` es síncrona (no devuelvas una promesa) y puede devolver una
 * función de limpieza o un `PluginViewSectionMount`.
 *
 * - Por defecto, cambiar de sección DESMONTA la anterior (su limpieza) y monta la nueva
 *   en un `el` nuevo; salir de la vista desmonta la que haya, y en un iPhone también
 *   volver a la lista de secciones.
 * - Con `retainSections: true`, cada sección se monta una sola vez, la primera vez que se
 *   visita, y al cambiar de sección o salir de la vista se OCULTA en vez de desmontarse
 *   (`onVisibilityChange(false)`); al volver, `onVisibilityChange(true)`, con su DOM y su
 *   desplazamiento vertical como estaban. Solo se desmontan al desregistrar la vista o al
 *   apagar el plugin. Una sección oculta NO sale del documento ni cambia de nodo: se
 *   queda bajo `hidden` (`display: none`), así que mide 0 hasta que vuelve a verse.
 * - Una `mountSection` que lanza no tumba Hebra: se anota con el id del plugin, la columna
 *   enseña «No se pudo abrir ‹sección›» con «Reintentar» y esa sección no cuenta como
 *   montada.
 * - `ui.revealView` NO monta nada al momento: Hebra llama a `mountSection` después, cuando
 *   el contenido de la sección va a verse (en un iPhone, cuando el usuario toca la sección
 *   en la lista o la pides con `section`). No des una sección por montada justo después
 *   de `revealView`: lo que tengas que hacer con ella va dentro de `mountSection`.
 * - Desde dentro de `mountSection`, de la limpieza o de `onVisibilityChange` puedes llamar
 *   a `ui.revealView`, `ui.updateView` y `ui.updateViewSection`, y desregistrar la vista.
 *   Un cambio de sección pedido ahí se aplica al terminar lo que estaba a medias (nunca
 *   hay dos secciones a la vista), y si desregistras la vista dentro de `mountSection`,
 *   Hebra llama enseguida a la limpieza que devuelvas.
 *
 * **El elemento `el`.** Ya está en el documento cuando `mountSection` lo recibe. Ocupa la
 * columna de contenido entera, a lo ancho y a lo alto (en un iPhone, lo que queda bajo la
 * barra con el botón de vuelta), sin margen ni relleno ni ancho máximo, y se desplaza en
 * vertical si el contenido es más alto (`overflow-y: auto`; en horizontal no se desplaza).
 * Lleva la clase `hebra-module-view-content` (la misma del diálogo de vista),
 * `hebra-module-view-main-content` y `data-section="<id>"`. Su padre lleva las clases
 * estables `hebra-module-view` y `hebra-module-view-main` y mide lo mismo: es donde poner
 * `container-type` para consultas `@container`. El ancho de esa columna lo decide la
 * ventana, no el plugin: puede ir de menos de 400 px (iPhone, ventana mínima) a más de
 * 1000; el contenido tiene que adaptarse.
 *
 * **Entrar y salir.** Se entra con `ui.revealView(id)` o `ui.revealView(id, { section })`
 * (también desde un comando o desde el `onClick` de un botón de `ribbon`); se sale cuando el
 * usuario elige una nota, una carpeta u otra vista en la barra lateral, abre Ajustes o
 * busca en sus notas. La sección elegida se recuerda en este dispositivo (no se
 * sincroniza, y se borra al desinstalar el plugin con sus datos); la primera vez, o si la
 * recordada ya no existe, se abre la primera. Con la vista YA abierta, `ui.revealView(id)`
 * sin sección no cambia la que se ve. Al entrar, el foco va a la fila de la sección en la
 * lista, no al contenido (en un iPhone no se mueve). En un iPhone o una ventana estrecha
 * se ve primero la lista de secciones y, al tocar una, su contenido con un botón para
 * volver; con `ui.revealView(id, { section })` se ve directamente el contenido.
 *
 * **Secciones.** Al menos una, cada una con `id` y `title` no vacíos e ids sin repetir; si
 * no, `registerView` lanza `invalid-argument` y no registra nada.
 *
 * **Compatibilidad.** `api.has('ui.view.main')` es `true` desde la 1.3 y `false` antes (un
 * Hebra anterior responde `false` a cualquier nombre que no conoce, sin lanzar). También
 * vale comparar `api.apiVersion`:
 *
 * ```ts
 * const [major, minor] = api.apiVersion.split('.').map(Number);
 * const mainAvailable = major === 1 && minor >= 3;
 * ```
 *
 * Un Hebra anterior a la 1.3 NO rechaza una vista con `placement: 'main'`: la registra sin
 * avisar y no la enseña en ningún sitio (no es pestaña del inspector ni diálogo, y
 * `revealView` abre el inspector en «Estadísticas»). Por eso hay que preguntar antes.
 *
 * **Cambiar de sitio sin reiniciar.** Para ofrecer «barra lateral / pantalla principal»,
 * desregistra lo que haya y registra lo otro, en el mismo momento si quieres. Hebra
 * desmonta lo que estuviera montado y, si la vista `'main'` ocupaba la pantalla principal,
 * vuelve a la lista de notas:
 *
 * ```ts
 * let offs = [api.ui.registerView({ id: 'mi-vista', title, icon, placement: 'main', sections, mountSection })];
 * // …el usuario elige «barra lateral» en los ajustes del plugin:
 * offs.forEach((off) => off());
 * offs = [api.ui.registerView({ id: 'mi-columna', title, icon, mount, unmount })];
 * ```
 */
export interface PluginMainViewDefinition {
  id: string;
  title: string;
  /** Nombre Lucide. */
  icon: string;
  placement: 'main';
  /** Las filas de la columna central, en este orden. */
  sections: readonly PluginViewSection[];
  /** `true`: las secciones visitadas se ocultan en vez de desmontarse (ver arriba). */
  retainSections?: boolean;
  mountSection(el: HTMLElement, sectionId: string): void | (() => void) | PluginViewSectionMount;
}

/** Desde la 1.3. Opciones de `ui.revealView`. */
export interface PluginRevealViewOptions {
  /** La sección de una vista `'main'` que se abre (y queda como la recordada). */
  section?: string;
}

/** Desde la 1.3. Lo que `ui.updateView` puede cambiar de una vista ya registrada. */
export interface PluginViewPatch {
  title?: string;
}

/** Desde la 1.3. Lo que `ui.updateViewSection` puede cambiar de una sección. `null` quita
 *  el icono, la segunda línea o el aviso. */
export interface PluginViewSectionPatch {
  title?: string;
  icon?: string | null;
  subtitle?: string | null;
  badge?: string | number | null;
}

export interface PluginCommandDefinition {
  id: string;
  name: string;
  run(): void | Promise<void>;
}

export interface PluginRibbonDefinition {
  icon: string;
  title: string;
  onClick(event?: MouseEvent): void;
  badge?: number | null;
  pending?: boolean;
  /**
   * La vista a la que pertenece este botón: refleja `aria-pressed` mientras esa vista está
   * a la vista. El botón no abre nada por sí solo: lo hace `onClick` (con `ui.revealView`).
   *
   * - Vista `'column'`: está pulsado mientras su pestaña del inspector es la activa y se
   *   ve, y en ese estado el clic PLIEGA el inspector en vez de llamar a `onClick` (así
   *   desde la 1.0).
   * - Vista `'main'` (desde la 1.3): está pulsado mientras ocupa la pantalla principal y
   *   el clic llama SIEMPRE a `onClick`.
   */
  viewId?: string;
}

export interface PluginRibbonHandle {
  update(patch: Partial<Omit<PluginRibbonDefinition, 'onClick' | 'viewId'>>): void;
  remove(): void;
}

export interface PluginMenuItem {
  label: string;
  onClick(): void;
  disabled?: boolean;
  icon?: string;
}
export interface PluginMenuSeparator {
  separator: true;
}
export type PluginMenuEntry = PluginMenuItem | PluginMenuSeparator;

export interface PluginModalHandle {
  close(): void;
}
export interface PluginModalOptions {
  title?: string;
  onClosed?(): void;
}

export type PluginStatusBarTone = 'muted' | 'ok' | 'busy' | 'warning' | 'danger';

export interface PluginStatusBarItemDefinition {
  /** Único en toda la app. */
  id: string;
  text: string;
  icon?: string;
  tooltip?: string;
  onClick?: () => void;
  order?: number;
  tone?: PluginStatusBarTone;
}

export interface PluginStatusBarItemHandle {
  update(patch: Partial<Omit<PluginStatusBarItemDefinition, 'id'>>): void;
  remove(): void;
}

/**
 * Vistas, comandos, ribbon, panel de ajustes, modal, aviso, menú, iconos y barra de
 * estado. Cada registro se deshace solo al apagar el plugin. Un callback que lanza
 * (comando, clic, panel) se registra con el id del plugin y no tumba la app (§8.6).
 */
export interface PluginUi {
  /** Desde la 1.3 admite también una vista `'main'` (`PluginMainViewDefinition`); si sus
   *  `sections` no valen, lanza `invalid-argument`. */
  registerView(view: PluginViewDefinition | PluginMainViewDefinition): PluginUnregister;
  /**
   * Enseña la vista: la pestaña del inspector, el diálogo o, con `'main'`, la pantalla
   * principal. Un id sin registrar no hace nada.
   *
   * `options.section` (desde la 1.3) abre una vista `'main'` en esa sección, esté ya
   * abierta o no, y la deja como la recordada. Si esa sección no existe no lanza: con la
   * vista ya abierta se queda en la que se ve; si no, abre la recordada o, si no hay, la
   * primera. Sin `options.section` pasa lo mismo: la vista abierta no cambia de sección.
   * Con `'column'` y `'dialog'` no cuenta.
   *
   * No monta nada antes de volver (ver «Montaje» en `PluginMainViewDefinition`). Revelar
   * una vista `'column'` mientras una `'main'` ocupa la pantalla principal sale de ella a
   * las notas.
   */
  revealView(id: string, options?: PluginRevealViewOptions): void;
  /**
   * Desde la 1.3 (antes no existe: comprueba `api.has('ui.view.main')`). Cambia el
   * `title` de una vista de ESTE plugin sin desregistrarla (cualquier `placement`): el
   * cambio se ve en el acto y lo que esté montado sigue montado. Un id que no es de una
   * vista de este plugin no hace nada; un `title` vacío lanza `invalid-argument`.
   */
  updateView(id: string, patch: PluginViewPatch): void;
  /**
   * Desde la 1.3 (antes no existe: comprueba `api.has('ui.view.main')`). Cambia `title`,
   * `icon`, `subtitle` o `badge` de una sección de una vista `'main'` de este plugin, sin
   * desmontar nada. Solo se tocan los campos que vengan en `patch`. Una vista o una
   * sección que no existen no hacen nada; un `title` vacío lanza `invalid-argument`.
   */
  updateViewSection(viewId: string, sectionId: string, patch: PluginViewSectionPatch): void;
  registerCommand(command: PluginCommandDefinition): PluginUnregister;
  ribbon(item: PluginRibbonDefinition): PluginUnregister;
  ribbonItem(item: PluginRibbonDefinition): PluginRibbonHandle;
  settingsPanel(mount: PluginMountFn): PluginUnregister;
  openModal(mount: PluginMountFn, options?: PluginModalOptions): PluginModalHandle;
  notice(text: string, onClick?: () => void): void;
  setIcon(el: HTMLElement, name: string): void;
  setTooltip(el: HTMLElement, text: string): void;
  openMenu(items: readonly PluginMenuEntry[], position: { x: number; y: number }): void;
  /** Ajustes de Hebra en el panel de este plugin. */
  openSettings(): void;
  registerStatusBarItem(item: PluginStatusBarItemDefinition): PluginStatusBarItemHandle;
  /** Tras abrir la biblioteca; si ya está abierta, en el acto. */
  onReady(callback: () => void): PluginUnregister;
  openExternal(url: string): Promise<void>;
  /**
   * Selector de carpeta DE LA BIBLIOTECA (no del sistema de ficheros). Resuelve con el
   * ID de la carpeta elegida (el mismo que `vault.foldersList` y `PluginNoteSummary.folderId`),
   * NO con su ruta ni su nombre. Resuelve `null` si el usuario cancela y también si elige
   * «Raíz»: para la raíz, `vault.rootFolderId()`.
   */
  pickFolder(): Promise<string | null>;
}

// ---- editor (capacidad `editor`) ----

export interface PluginCodeBlockContext {
  language: string;
  /** Frontmatter de la nota, con la forma de `ctx.frontmatter` de Obsidian. */
  frontmatter: Readonly<Record<string, unknown>> | null;
}

export type PluginCodeBlockRenderer = (
  el: HTMLElement,
  source: string,
  ctx: PluginCodeBlockContext
) => void | (() => void);

/**
 * Extensiones de CodeMirror y bloques ```lenguaje```. En una nota protegida desbloqueada
 * NO se montan (§8.5). La extensión tiene que construirse con el `@codemirror/state` que
 * presta Hebra (`hebraShared()`, §6); una de otra copia lanza `extension-rechazada`.
 */
export interface PluginEditor {
  registerExtension(extension: Extension): PluginUnregister;
  registerCodeBlock(language: string, render: PluginCodeBlockRenderer): PluginUnregister;
}

// ---- vault (capacidades `vault.read` y `vault.write`, §5.2) ----

/** Revisión de una nota: la base de la que parte una escritura (control de concurrencia). */
export interface PluginNoteRevision {
  localSeq: number;
  bodySha256: string;
}

/**
 * Una nota. Una nota protegida llega con `locked: true` y `body: null`: el plugin nunca
 * recibe ni su texto ni su envoltorio cifrado (§5.2, §8.5).
 */
export interface PluginNote {
  id: string;
  folderId: string;
  title: string;
  body: string | null;
  locked: boolean;
  createdAt: number;
  updatedAt: number;
  favorite: boolean;
  trashedAt: number | null;
  archivedAt: number | null;
  revision: PluginNoteRevision;
}

export interface PluginNoteListItem {
  id: string;
  title: string;
  /** Vacío en una nota protegida. */
  excerpt: string;
  createdAt: number;
  updatedAt: number;
  favorite: boolean;
  locked: boolean;
}

export interface PluginNotesPage {
  items: PluginNoteListItem[];
  nextCursor: string | null;
}

export interface PluginNoteSummary extends PluginNoteListItem {
  folderId: string;
  trashedAt: number | null;
  archivedAt: number | null;
  /**
   * Desde la 1.1. La revisión que Hebra tiene guardada de la nota (`localSeq` de la fila
   * y hash del cuerpo): la base de un `noteSave` o `notesRewriteBatch` sin releer el
   * cuerpo. `null` solo si el motor de la biblioteca no informó de `localSeq`.
   */
  revision: PluginNoteRevision | null;
  /**
   * Desde la 1.1. SHA-256 hexadecimal del cuerpo, el que Hebra guarda con la nota (no se
   * calcula al pedirlo, así que no cuesta leer el cuerpo). Es el mismo valor que
   * `revision.bodySha256`. Vale también en una nota protegida: es el hash del cuerpo
   * guardado, no su texto.
   */
  bodySha256: string;
}

/** Ámbito de `notesPage`: toda la biblioteca o una carpeta. */
export type PluginNotesScope =
  { kind: 'all' } | { kind: 'folder'; folderId: string; subfolders?: boolean };

export type PluginNoteSaveResult =
  | { outcome: 'saved'; id: string; revision: PluginNoteRevision }
  /** La nota cambió entre medias: Hebra guardó una COPIA de conflicto con ese id. */
  | { outcome: 'redirected'; id: string; revision: PluginNoteRevision };

export interface PluginNoteRewrite {
  /** Exige secuencia Y hash observados; úsalo al deshacer. Por defecto basta uno. */
  strictRevision?: boolean;
  id: string;
  body: string;
  expected: PluginNoteRevision;
}

export interface PluginNotesRewriteResult {
  written: string[];
  /** No se escribieron: cambiaron entre medias o ya no existen. */
  stale: string[];
  /**
   * Campo opcional añadido sin subir la versión del API: las de `stale` que ya no existen
   * (siempre ⊆ `stale`). Reintentarlas no converge: no las releas ni las reintentes. Solo
   * viene si hay alguna; un host anterior no lo trae (trátalo como `[]`).
   */
  missing?: string[];
  /** Cuerpo efectivo y revisión confirmados en la misma transacción que la escritura. */
  committed: { id: string; body: string; revision: PluginNoteRevision }[];
}

export interface PluginNoteMutationGuard {
  revision: PluginNoteRevision;
  folderId: string;
}

export interface PluginFolderMutationGuard {
  name: string;
  parentId: string | null;
}

export interface PluginFolder {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Notas vivas cuya carpeta es esta. Solo en `foldersList()` (crear, renombrar o
   *  mover devuelven la carpeta sin recontar). */
  noteCount?: number;
}

export interface PluginFile {
  id: string;
  folderId: string;
  name: string;
  sha256: string;
  byteLength: number;
  mime: string | null;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
}

export interface PluginFilesPage {
  items: PluginFile[];
  nextCursor: string | null;
}

export interface PluginBlobPutResult {
  sha256: string;
  byteLength: number;
  alreadyPresent: boolean;
}

/** Cambios de la biblioteca, solo ids (nunca contenido). */
export type PluginVaultChange =
  | { kind: 'library-changed'; ids: string[]; reason: string }
  | { kind: 'note-changed'; id: string; change: string };

/**
 * Subconjunto del almacén de Hebra (§5.2). Las escrituras reciben el cuerpo y Hebra
 * deriva título y metadatos dentro. Lo irreversible (purgar, vaciar papelera, versiones)
 * no está.
 *
 * **Título** (lo deriva Hebra, nunca el plugin). El título de una nota sale de su cuerpo:
 * la propiedad `title:` del frontmatter si la hay; si no, el primer encabezado `# …`.
 *
 * - `noteCreate`: el título es el que da el cuerpo (`''` si no da ninguno).
 * - `noteSave` y `notesRewriteBatch`: también el que da el cuerpo NUEVO, así que cambiar
 *   el `# …` o el `title:` cambia el título. Lo único que se CONSERVA es un título que
 *   no salía del cuerpo (el nombre de fichero que pone la importación a una nota sin
 *   `title:` ni `# …`) cuando el cuerpo nuevo tampoco da ninguno: reescribir esa nota no
 *   la deja «Sin título».
 * - Para fijar un título sin tocar el `# …`, escribe la propiedad con
 *   `markdown.withTitle(body, title)`, que gana al H1.
 *
 * **Tareas marcadas.** En `noteSave` y `notesRewriteBatch`, una tarea que el cuerpo
 * nuevo pasa de `- [ ]` a `- [x]` (sin cambiar nada más de su línea) baja al final de su
 * lista con sus hijas, y una que pasa de `- [x]` a `- [ ]` sube detrás de la última
 * pendiente, como al marcarla o desmarcarla en el editor, si el ajuste «Mover las tareas
 * completadas al final» del dispositivo está encendido y la revisión esperada es la
 * guardada. Lo guardado puede no ser el cuerpo enviado: `revision.bodySha256` es el de
 * lo guardado. `createFakePluginApi` (`testing`) guarda el cuerpo tal cual.
 */
export interface PluginVault {
  libraryId(): string;
  /** Id de la carpeta raíz de la biblioteca (`folderId` de una nota que no está en
   *  ninguna carpeta, `parentId` de una carpeta de primer nivel es `null`). */
  rootFolderId(): string;
  notesPage(
    cursor: string | null,
    limit: number,
    scope?: PluginNotesScope
  ): Promise<PluginNotesPage>;
  noteRead(id: string): Promise<PluginNote | null>;
  noteSummary(ids: readonly string[]): Promise<PluginNoteSummary[]>;
  noteCreate(input: { folderId: string | null; body: string }): Promise<PluginNote>;
  noteSave(input: {
    id: string;
    body: string;
    expected: PluginNoteRevision;
  }): Promise<PluginNoteSaveResult>;
  notesRewriteBatch(
    entries: readonly PluginNoteRewrite[],
    options?: { cause?: string | null; touchUpdatedAt?: boolean }
  ): Promise<PluginNotesRewriteResult>;
  noteMove(id: string, folderId: string): Promise<PluginNote>;
  /** CAS de revisión y carpeta; devuelve la nota del commit o null sin efectos. */
  noteMoveIfUnchanged(
    id: string,
    folderId: string,
    expected: PluginNoteMutationGuard
  ): Promise<PluginNote | null>;
  noteTrash(id: string): Promise<PluginNote>;
  /** Solo tira una nota activa, sin protección, con revisión y carpeta intactas. */
  noteTrashIfUnchanged(id: string, expected: PluginNoteMutationGuard): Promise<PluginNote | null>;
  /** Desde 1.2: solo restaura una nota en papelera si conserva fecha y revisión,
   * sin tocar una protegida, modificada o ya restaurada. `false` si no coincide. */
  noteRestore(
    id: string,
    expected: {
      trashedAt: number;
      revision: PluginNoteRevision;
    }
  ): Promise<boolean>;
  /** Como noteRestore; devuelve la nota del commit o null cuando la guardia falla. */
  noteRestoreIfUnchanged(
    id: string,
    expected: { trashedAt: number; revision: PluginNoteRevision }
  ): Promise<PluginNote | null>;
  foldersList(): Promise<PluginFolder[]>;
  folderCreate(parentId: string | null, name: string): Promise<PluginFolder>;
  folderRename(id: string, name: string): Promise<PluginFolder>;
  /** CAS de nombre y padre; devuelve la carpeta confirmada o null sin efectos. */
  folderRenameIfUnchanged(
    id: string,
    name: string,
    expected: PluginFolderMutationGuard
  ): Promise<PluginFolder | null>;
  folderMove(id: string, parentId: string | null): Promise<PluginFolder>;
  /** CAS de nombre y padre; mantiene las restricciones de destino y ciclos. */
  folderMoveIfUnchanged(
    id: string,
    parentId: string | null,
    expected: PluginFolderMutationGuard
  ): Promise<PluginFolder | null>;
  /** Desde 1.2: marca lápida solo una carpeta con nombre y padre esperados;
   * permite hijas ya retiradas vacías, pero no hijas vivas ni notas o recursos
   * asociados en ningún nivel, incluso si están retirados. */
  folderTrashEmpty(
    id: string,
    expected: { name: string; parentId: string | null }
  ): Promise<boolean>;
  filesPage(
    folderId: string,
    subfolders: boolean,
    cursor: string | null,
    limit?: number
  ): Promise<PluginFilesPage>;
  /** Por id o por nombre (`fichero.ext` o `ruta/fichero.ext`). */
  fileRead(ref: string): Promise<PluginFile | null>;
  fileCreate(folderId: string | null, name: string, sha256: string): Promise<PluginFile>;
  fileReplace(id: string, sha256: string, expectedSha256?: string | null): Promise<PluginFile>;
  fileTrash(id: string): Promise<PluginFile>;
  /** Los bytes de un fichero por su `sha256` (el de `PluginFile`). Si este dispositivo
   * todavía no los ha bajado, Hebra los pide al relé de sync, los guarda y los entrega:
   * puede tardar lo que una descarga. `null` si no se pueden conseguir ahora (sin sync,
   * sin red o el relé no los tiene); no rechaza por eso y otra llamada lo reintenta. */
  blobRead(sha256: string): Promise<Uint8Array | null>;
  blobPut(bytes: Uint8Array, options?: { mime?: string | null }): Promise<PluginBlobPutResult>;
  onChange(listener: (change: PluginVaultChange) => void): PluginUnregister;
}

// ---- workspace (siempre, §5.2) ----

export interface PluginActiveNote {
  readonly id: string;
  readonly folderId: string;
  readonly title: string;
}

export interface PluginNotesChange {
  readonly ids: readonly string[];
  readonly reason: string;
}

export type PluginFolderRenameEvent =
  | { kind: 'folder-rename'; folderId: string; newName: string }
  | { kind: 'folder-move'; folderId: string; newParentId: string | null };

/** `false` cancela el renombrado o el movimiento. Varias guardias: basta un `false`. */
export type PluginFolderRenameGuard = (event: PluginFolderRenameEvent) => Promise<boolean>;

export interface PluginNoteTitleRenamedEvent {
  noteId: string;
  folderId: string;
  oldTitle: string;
  newTitle: string;
  undo(): void;
}

export interface PluginWorkspace {
  activeNote(): PluginActiveNote | null;
  onActiveNoteChange(listener: (note: PluginActiveNote | null) => void): PluginUnregister;
  openNote(id: string): void;
  selectFolder(id: string): void;
  /** Abre la búsqueda de Hebra con `query` (p. ej. `path:"21 Proyectos"`). */
  openSearch(query: string): void;
  /** Cambios de ESTRUCTURA de carpetas (id, padre o nombre). */
  onFoldersChange(listener: (folders: readonly PluginFolder[]) => void): PluginUnregister;
  onNotesChange(listener: (change: PluginNotesChange) => void): PluginUnregister;
  onBeforeFolderRename(guard: PluginFolderRenameGuard): PluginUnregister;
  onNoteTitleRenamed(listener: (event: PluginNoteTitleRenamedEvent) => void): PluginUnregister;
  /** Apaga y vuelve a encender este plugin; `true` si quedó activo. */
  restart(): Promise<boolean>;
}

// ---- markdown (siempre) ----

/** Posiciones (índices de UTF-16, los de `String.prototype.slice`) de un bloque de
 *  frontmatter al principio del cuerpo. */
export interface PluginFrontmatterRange {
  /** Siempre `0`: el bloque empieza en la primera línea (con BOM incluido, si lo hay). */
  start: number;
  /** Justo DESPUÉS del delimitador de cierre (`---` o `...`) Y de su salto de línea
   *  (`\n` o `\r\n`); si el cuerpo acaba en el delimitador sin salto, `body.length`.
   *  `body.slice(end)` es lo que va detrás del frontmatter. */
  end: number;
}

export interface PluginMarkdown {
  /** El cuerpo con la propiedad raíz `key` escrita (o quitada con `null`). Si el
   *  frontmatter no se puede parchear sin riesgo, devuelve el cuerpo tal cual. */
  setProperty(body: string, key: string, value: string | readonly string[] | null): string;
  /** Frontmatter con la forma de Obsidian, o `null` si no hay. */
  frontmatter(body: string): Readonly<Record<string, unknown>> | null;
  /**
   * El cuerpo con `title: "<title>"` en el frontmatter (creándolo si no hay), que es lo
   * que Hebra lee como título antes que el `# …` (ver `PluginVault`). Es el mismo formato
   * que escribe Hebra al importar una nota sin título. Devuelve el cuerpo TAL CUAL si ya
   * tiene ese título, si `title` está vacío o tiene saltos de línea, si el frontmatter no
   * se puede parchear sin riesgo o si el resultado no daría exactamente ese título.
   */
  withTitle(body: string, title: string): string;
  /** Dónde está el frontmatter del principio del cuerpo (`---` en la primera línea hasta
   *  el `---` o `...` de cierre), o `null` si no empieza por uno o no se cierra. */
  frontmatterRange(body: string): PluginFrontmatterRange | null;
}

// ---- storage (siempre, §5.2 y §9) ----

/**
 * Ajustes del plugin para ESTA biblioteca, como `loadData`/`saveData` de Obsidian. Es el
 * ámbito que viaja con la biblioteca entre dispositivos (§9); hasta que llegue esa tarea
 * se guarda en este dispositivo, en la misma clave que usaban los módulos compilados.
 */
export interface PluginSettingsStorage {
  load<T = unknown>(): Promise<T | null>;
  save(value: unknown): Promise<void>;
  /** Cambio guardado desde otro sitio (otra pestaña; después, el sync). */
  onChange(listener: (value: unknown) => void): PluginUnregister;
}

/** Valores pequeños SOLO de este dispositivo y biblioteca (nunca se sincronizan). */
export interface PluginDeviceStorage {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export interface PluginStorage {
  readonly settings: PluginSettingsStorage;
  readonly device: PluginDeviceStorage;
  /** Nombre de base IndexedDB propio del plugin para `name`. */
  indexedDbName(name: string): string;
}

// ---- red, nativo y entorno ----

export interface PluginHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface PluginHttpResponse {
  status: number;
  /** Nombres en minúscula. */
  headers: Record<string, string>;
  text: string;
}

/** Opciones de `http.requestUserHost` (desde la 1.1). */
export interface PluginRequestUserHostOptions {
  /** Por qué pide el permiso; sale en el diálogo. Hasta 200 caracteres. */
  reason?: string;
}

/**
 * Sin CORS. Un 4xx/5xx vuelve como respuesta. Solo llega a dos clases de host:
 *
 * - los de `network.hosts` del `hebra.json`, que el usuario ve al instalar;
 * - los que ELIGE el usuario (un webhook, su propio servidor), si el manifiesto declara
 *   `network.userHosts: true` y el usuario lo ha permitido con `requestUserHost`.
 *
 * Cualquier otro rechaza con `host-not-declared` sin salir a la red.
 *
 * En la web, `http` pasa por un relé del mismo origen de `app.hebra.pro` que solo llega
 * a los hosts EXACTOS de `network.hosts` (los del usuario no existen allí): un host que
 * solo casa con un comodín, o con otro puerto, rechaza con `unavailable-on-platform`.
 * La respuesta tiene la misma forma que en las apps.
 */
export interface PluginHttp {
  /**
   * Hace la petición (ver arriba qué hosts alcanza).
   *
   * Nunca pongas secretos en la consulta de la URL; usa la cabecera `Authorization`. La URL
   * entera (con su consulta) puede quedar en los registros de un servidor por el que pasa,
   * también el relé de la web; `Authorization` no.
   */
  request(request: PluginHttpRequest): Promise<PluginHttpResponse>;
  /**
   * Pide permiso para llamar al host de `url`, que ha elegido el usuario. Solo `https:`,
   * host exacto (sin comodines; el puerto y la ruta no cuentan) y nombre DNS (no una IP).
   * La PRIMERA vez para cada host Hebra pregunta al usuario con su diálogo («‹Plugin›
   * quiere conectarse a ‹host›», «Permitir» / «No permitir»). El sí se recuerda para este
   * plugin y en este dispositivo (no se sincroniza) y desde entonces `request` acepta ese
   * host; el usuario lo puede quitar en Ajustes › Plugins. El no, no se recuerda.
   *
   * Resuelve `true` si el host ya se puede usar (está en `network.hosts` o ya se
   * permitió) o si el usuario dice que sí; `false` si dice que no o cierra el diálogo.
   * Rechaza con `host-not-declared` si `hebra.json` no declara `network.userHosts: true`;
   * con `invalid-argument` si la URL no es `https:` o el host no vale; y, como el resto
   * de `http`, con `capability-not-declared` o `unavailable-on-platform`. En la web
   * `http` va por el relé de `app.hebra.pro`, que solo llega a `network.hosts`: ahí
   * rechaza siempre con `unavailable-on-platform` sin preguntar nada.
   *
   * Desde la 1.1, `options.reason` es un texto corto (hasta 200 caracteres; si no,
   * `invalid-argument`) que el diálogo enseña al usuario. No hace falta una petición
   * `request` después: se puede llamar solo para pedir el permiso en el momento en que
   * el usuario elige el host, p. ej. al guardar un ajuste:
   *
   * ```ts
   * // Al guardar el ajuste «webhook», no en la primera entrega.
   * const ok = await api.http.requestUserHost(settings.webhookUrl, {
   *   reason: 'Para enviar el aviso de cada entrega a tu webhook.'
   * });
   * if (!ok) showError('Sin permiso no se pueden enviar avisos.');
   * ```
   */
  requestUserHost(url: string, options?: PluginRequestUserHostOptions): Promise<boolean>;
}

/**
 * Llavero del dispositivo, propio de cada plugin: un plugin no lee los secretos de otro
 * ni los de Hebra. Nunca se sincroniza (cada dispositivo guarda los suyos).
 *
 * - Apps de macOS, iOS, Linux y Windows: el llavero del sistema.
 * - Web: solo memoria de la pestaña (se pierde al recargar).
 * - Android: no disponible (`unavailable-on-platform`).
 *
 * La clave es de 1 a 64 caracteres `[A-Za-z0-9._-]`, sin `..`; el valor, texto de hasta
 * 64 KiB (UTF-8). Si no, `invalid-argument`. `get` de una clave sin valor resuelve `null`.
 */
export interface PluginSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

export type PluginTcpEvent =
  | { kind: 'connection'; id: number }
  | { kind: 'data'; id: number; bytes: number[] }
  | { kind: 'error'; id: number }
  | { kind: 'close'; id: number };

/** Servidor en 127.0.0.1, solo en escritorio y solo en los puertos que Hebra permite. */
export interface PluginTcp {
  listen(port: number, onEvent: (event: PluginTcpEvent) => void): Promise<number>;
  write(id: number, data: string): Promise<void>;
  end(id: number, data?: string): Promise<void>;
  destroy(id: number): Promise<void>;
  close(): Promise<void>;
}

export type PluginSystemNotificationOutcome = 'shown' | 'denied' | 'unavailable' | 'pending';

export interface PluginNotify {
  /** Aviso del SISTEMA (escritorio). `pending`: se pidió permiso y saldrá si se concede. */
  system(input: { title: string; body: string }): PluginSystemNotificationOutcome;
}

/** Mantener la app viva en segundo plano (efectivo en macOS; sin efecto en el resto). */
export interface PluginBackground {
  hold(): Promise<void>;
  release(): Promise<void>;
}

export interface PluginEnv {
  /** Dónde corre la APP: en la app de iPad es `'ios'`; en el Safari de un iPad o un
   *  iPhone es `'web'`. Para saber si el dispositivo es un iPhone o iPad, `appleMobile()`. */
  readonly platform: PluginPlatform;
  /** App de escritorio (macOS, Linux, Windows), no la web ni el móvil. */
  readonly isDesktopApp: boolean;
  /**
   * Desde la 1.1. La versión de la APP de Hebra que corre (la de `package.json` del build,
   * p. ej. `'0.1.0'`; `'desarrollo'` si el build no la define). NO es la versión de esta
   * API (`api.apiVersion`) ni el commit del build: sirve para diagnóstico y para pegar en
   * un informe de fallo, no para decidir qué funciones existen (para eso, `api.has()` y
   * `apiVersion`).
   */
  readonly hostVersion: string;
  locale(): string;
  readonly online: boolean;
  onOnlineChange(listener: (online: boolean) => void): PluginUnregister;
  onVisibilityChange(listener: (visible: boolean) => void): PluginUnregister;
  /**
   * `true` en un iPhone o un iPad, en la app Y en la web (el iPad que se anuncia como
   * Mac se reconoce por la pantalla táctil). Es lo que mira un plugin para comportarse
   * como en la app móvil de Obsidian (la clase `is-mobile`). Distinto de `platform`:
   * `platform` dice qué build de Hebra corre (`'web'` en el Safari del iPad) y esto, qué
   * dispositivo es.
   */
  appleMobile(): boolean;
  /** El ajuste «Usar fechas ISO 8601» de Hebra (Ajustes › General, por dispositivo):
   *  si está encendido, las fechas que enseñe el plugin deberían ir como `2026-10-03`. */
  isoDates(): boolean;
  /** Avisa cuando el usuario cambia ese ajuste, con el valor nuevo. */
  onIsoDatesChange(listener: (on: boolean) => void): PluginUnregister;
}

// ---- La API ----

export interface HebraPluginApi {
  /** La que implementa Hebra, p. ej. `'1.4.0'`. Con ella un plugin decide si puede usar
   *  algo añadido en una versión menor (p. ej. `placement: 'main'`, desde la 1.3). */
  readonly apiVersion: string;
  readonly plugin: { readonly id: string; readonly version: string };
  /** Una capacidad: declarada Y disponible en esta plataforma. Una función del anfitrión
   *  (`PluginHostFeature`, desde la 1.3): si este Hebra la tiene. Un nombre que este Hebra
   *  no conoce da `false`, nunca lanza. */
  has(capability: PluginCapability | PluginHostFeature): boolean;
  readonly env: PluginEnv;
  readonly ui: PluginUi;
  readonly editor: PluginEditor;
  readonly vault: PluginVault;
  readonly workspace: PluginWorkspace;
  readonly markdown: PluginMarkdown;
  readonly storage: PluginStorage;
  readonly http: PluginHttp;
  readonly secrets: PluginSecrets;
  readonly tcp: PluginTcp;
  readonly notify: PluginNotify;
  readonly background: PluginBackground;
}

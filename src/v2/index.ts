/**
 * API 2.0 de los plugins de Hebra: contrato del lote L1 del plan C1
 * (`docs/audits/2026-10-11-plan-c1-aislamiento-plugins.md` §6; contrato en
 * `docs/SPEC-PLUGINS-EXTERNOS.md` §5.5), con código desde L4: la entrada
 * `hebra-plugin-api/v2` (`PLUGIN_API_VERSION`, `isPluginApiError`) y su host falso
 * `hebra-plugin-api/v2/testing`. El paquete no sube de versión hasta publicar la `2.0.0`.
 *
 * La 1.x (`../index.ts`) NO cambia y sigue vigente hasta el corte (L8, fecha P1 de David):
 * un plugin 1.x sigue corriendo como hoy, en el contexto de Hebra. Un plugin 2.0 declara
 * `"apiVersion": "^2.0.0"` en `hebra.json` y corre AISLADO (§2, decisión 4; §8.1):
 *
 * - Cada plugin tiene su propio ORIGEN (`hebraplugin://<id>/` en macOS, iOS y Linux; un
 *   host no local en Windows; un vhost propio en la web). Su código corre en un marco
 *   OCULTO de ese origen (el «marco de ejecución»), sin el DOM, el almacenamiento ni la IPC
 *   de Hebra.
 * - Cada superficie (vista, panel de ajustes, modal, bloque de código) es otro marco del
 *   MISMO origen, hermano del de ejecución. `mount(el)` conserva su firma: `el` vive en el
 *   documento de la superficie y el plugin lo toca directamente, en síncrono, porque los
 *   dos marcos son del mismo origen. Lo que cambia es que `el.ownerDocument !== document`.
 * - Todo lo demás (biblioteca, red, secretos, eventos) va por un `MessagePort` que Hebra
 *   entrega al marco tras un handshake (`./protocol.ts`). El plugin no ve el puerto: usa
 *   esta API, que el arranque del marco implementa encima.
 * - El almacenamiento (IndexedDB y valores pequeños) lo SIRVE Hebra por mensajes: en
 *   WebKitGTK un marco de otro origen no persiste su IndexedDB ni su `localStorage`
 *   (medido, S2b, `docs/lotes/c1-l0-sondas-20261011.md`).
 *
 * Lo que este fichero reexporta de la 1.x tiene la MISMA forma y significado en la 2.0; lo
 * que declara aquí es lo que cambia. Los nombres son los de la 1.x a propósito: un plugin
 * migra cambiando `from 'hebra-plugin-api'` por `from 'hebra-plugin-api/v2'` y arreglando
 * solo lo que el compilador le señale.
 *
 * Importar esta entrada no exige `@codemirror/state` (L4): en el repo de Hebra los tipos que
 * no cambian se leen de `../index.ts`, que sí lo nombra (solo para `PluginEditor` de la 1.x);
 * al publicar, `scripts/plugin-api-publish.mjs` pone en `src/v2/_v1/` una copia de la 1.x sin
 * ese import y los ficheros de `v2/` la leen a ella.
 */
import type {
  PluginApiErrorCode as PluginApiErrorCodeV1,
  PluginCapability as PluginCapabilityV1,
  PluginCleanup,
  PluginCommandDefinition,
  PluginDeviceStorage as PluginDeviceStorageV1,
  PluginHostFeature,
  PluginKeepScreenOnResult,
  PluginMainViewDefinition,
  PluginMenuEntry,
  PluginModalHandle,
  PluginModalOptions,
  PluginMountFn,
  PluginNotify as PluginNotifyV1,
  PluginRevealViewOptions,
  PluginRibbonDefinition as PluginRibbonDefinitionV1,
  PluginSettingsStorage,
  PluginStatusBarItemDefinition,
  PluginStatusBarItemHandle,
  PluginTabViewDefinition,
  PluginUnregister,
  PluginViewDefinition,
  PluginViewPatch,
  PluginViewSectionPatch,
  PluginCodeBlockRenderer,
  PluginEnv,
  PluginVault,
  PluginWorkspace,
  PluginMarkdown,
  PluginHttp,
  PluginSecrets,
  PluginTcp,
  PluginBackground
} from './_v1/index';

// ---- Lo que no cambia: misma forma y mismo significado que en la 1.x ----

export type {
  PluginActiveNote,
  PluginBackground,
  PluginBlobPutResult,
  PluginCleanup,
  PluginCodeBlockContext,
  PluginCodeBlockRenderer,
  PluginCommandDefinition,
  PluginEnv,
  PluginFile,
  PluginFilesPage,
  PluginFolder,
  PluginFolderMutationGuard,
  PluginFolderRenameEvent,
  PluginFolderRenameGuard,
  PluginFrontmatterRange,
  PluginHostFeature,
  PluginHttp,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginJsonValue,
  PluginMainViewDefinition,
  PluginMarkdown,
  PluginMenuEntry,
  PluginMenuItem,
  PluginMenuSeparator,
  PluginModalHandle,
  PluginModalOptions,
  PluginMountFn,
  PluginNote,
  PluginNoteListItem,
  PluginNoteMutationGuard,
  PluginNoteRevision,
  PluginNoteRewrite,
  PluginNoteSaveResult,
  PluginNoteSummary,
  PluginNoteTitleRenamedEvent,
  PluginNotesChange,
  PluginNotesPage,
  PluginNotesRewriteResult,
  PluginNotesScope,
  PluginOpenNoteOptions,
  PluginOpenViewOptions,
  PluginPlatform,
  PluginRequestUserHostOptions,
  PluginRevealViewOptions,
  PluginSecrets,
  PluginSettingsStorage,
  PluginStatusBarItemDefinition,
  PluginStatusBarItemHandle,
  PluginStatusBarTone,
  PluginSystemNotificationOutcome,
  PluginSystemNotifyInput,
  PluginTabViewContext,
  PluginTabViewDefinition,
  PluginTabViewMount,
  PluginTcp,
  PluginTcpEvent,
  PluginUnregister,
  PluginVault,
  PluginVaultChange,
  PluginViewDefinition,
  PluginViewPatch,
  PluginViewPlacement,
  PluginViewSection,
  PluginViewSectionMount,
  PluginViewSectionPatch,
  PluginWorkspace
} from './_v1/index';

/**
 * Versiones que describe este fichero. El valor que implementa Hebra llega en
 * `api.apiVersion`; `PLUGIN_API_VERSION` es la que describen estos tipos.
 */
export type PluginApiVersion = `2.${number}.${number}`;

/** La versión de la API que describe esta entrada (la de Hebra: `HEBRA_PLUGIN_API_VERSION_V2`). */
export const PLUGIN_API_VERSION = '2.2.0';

// ---- Capacidades (§5.3 de la spec; §5.5 para lo nuevo) ----

/**
 * Las de la 1.x más `notify.sound` (requisito 3 de Tyrian, plan C1 §7 bis): reproducir un
 * sonido que el plugin registra, también sin que el usuario acabe de tocar nada. Se declara
 * en `hebra.json` y sale en la hoja de consentimiento (el texto lo decide David, P10).
 * `editor` sigue existiendo, pero ya no presta CodeMirror: da el editor declarativo.
 */
export type PluginCapability = PluginCapabilityV1 | 'notify.sound';

// ---- Errores ----

/**
 * Los de la 1.x salvo `extension-rechazada` (en la 2.0 no hay extensiones de CodeMirror),
 * más:
 *
 * - `user-activation-required`: lo pedido solo vale justo después de un gesto del usuario
 *   (un clic o una tecla) y Hebra no lo ve. Hoy: `clipboard.writeText`.
 * - `quota-exceeded` (L14): el plugin ha llenado su tope de almacenamiento. `storage.device`
 *   lo da al rechazar `flush()`; en `storage.indexedDB` la transacción aborta con un
 *   `DOMException` `QuotaExceededError`, como en un IndexedDB lleno del navegador.
 *
 * Un error de la 2.0 cruza el puerto serializado: SIEMPRE tiene esta forma y nunca es una
 * instancia de una clase del plugin. Se reconoce con `api.isError(error, code)`.
 */
export type PluginApiErrorCode =
  | Exclude<PluginApiErrorCodeV1, 'extension-rechazada'>
  | 'user-activation-required'
  | 'quota-exceeded';

export interface PluginApiErrorShape {
  readonly name: 'PluginApiError';
  readonly code: PluginApiErrorCode;
  readonly message: string;
}

/** Los códigos de `PluginApiErrorCode`, como valor (los comprueba `isPluginApiError`). */
export const PLUGIN_API_ERROR_CODES = [
  'capability-not-declared',
  'unavailable-on-platform',
  'capability-not-available',
  'host-not-declared',
  'note-locked',
  'invalid-argument',
  'plugin-disposed',
  'user-activation-required',
  'quota-exceeded'
] as const satisfies readonly PluginApiErrorCode[];

// La lista y el tipo son lo mismo: si a uno le falta un código, esto no compila.
type MissingErrorCode = Exclude<PluginApiErrorCode, (typeof PLUGIN_API_ERROR_CODES)[number]>;
const _everyErrorCode: [MissingErrorCode] extends [never] ? true : MissingErrorCode = true;
void _everyErrorCode;

/**
 * `true` si `error` es un error de la API 2.0 (y, con `code`, de ese código). Es lo mismo que
 * `api.isError`; sirve donde no hay `api` a mano (un test, un módulo que no la recibe).
 */
export function isPluginApiError(
  error: unknown,
  code?: PluginApiErrorCode
): error is PluginApiErrorShape {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name !== 'PluginApiError' || typeof candidate.message !== 'string') return false;
  if (!(PLUGIN_API_ERROR_CODES as readonly unknown[]).includes(candidate.code)) return false;
  return code === undefined || candidate.code === code;
}

// ---- Módulo del plugin ----

/**
 * Lo que exporta `hebra-main.mjs` de un plugin 2.0. Se ejecuta dentro del marco de
 * ejecución, nunca en el documento de Hebra. `globalThis`, `window` y `document` son los
 * de ese marco, que está OCULTO (no mide nada ni se ve): sirven para temporizadores,
 * `crypto.getRandomValues`, `navigator.locks` (por origen: lo comparten los marcos del
 * plugin) y para crear nodos que luego se añaden a una superficie.
 *
 * `window.indexedDB` y `window.localStorage` del marco existen, pero NO se garantiza que
 * persistan (en Linux se pierden al cerrar Hebra): se usa `api.storage`.
 */
export interface HebraPluginModule {
  activate(api: HebraPluginApi): void | PluginCleanup | Promise<void | PluginCleanup>;
}

// ---- ui (§5.5.2 de la spec) ----

/** Teclas modificadoras de un evento que llega serializado desde Hebra. */
export interface PluginModifierKeys {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/**
 * Un clic en una pieza que pinta HEBRA (botón del ribbon, decoración del editor). No es
 * un `MouseEvent`: cruza el puerto como datos. `x` e `y` son coordenadas de la ventana de
 * Hebra, las que entiende `ui.openMenu` sin `element`.
 */
export interface PluginPointerInfo extends PluginModifierKeys {
  readonly x: number;
  readonly y: number;
  /** `0` principal, `1` central, `2` secundario. */
  readonly button: number;
}

/** Como en la 1.x, salvo que `onClick` recibe el clic serializado, no un `MouseEvent`. */
export interface PluginRibbonDefinition extends Omit<PluginRibbonDefinitionV1, 'onClick'> {
  onClick(event?: PluginPointerInfo): void;
}

export interface PluginRibbonHandle {
  update(patch: Partial<Omit<PluginRibbonDefinition, 'onClick' | 'viewId'>>): void;
  remove(): void;
}

/**
 * Dónde abrir un menú de Hebra.
 *
 * - Con `element`: `x` e `y` son coordenadas del documento de `element` (el `clientX` y
 *   `clientY` de un clic dentro de una superficie). Hebra les suma la posición del marco.
 * - Sin `element`: coordenadas de la ventana de Hebra (las de `PluginPointerInfo`).
 */
export interface PluginMenuPosition {
  x: number;
  y: number;
  element?: HTMLElement;
}

/**
 * Lo mismo que la 1.x, con estas diferencias:
 *
 * - **Superficies.** `registerView`, `settingsPanel`, `openModal` y
 *   `editor.registerCodeBlock` siguen recibiendo `mount(el)`, pero `el` está en el
 *   documento de un marco de superficie: `el.ownerDocument !== document` y
 *   `el instanceof HTMLElement` es `false` (cada marco tiene sus constructores; compara
 *   con `el.ownerDocument.defaultView.HTMLElement` o no compares). Crear nodos con
 *   `document.createElement` y añadirlos a `el` funciona (se adoptan); crear con
 *   `el.ownerDocument` es lo correcto. La hoja `hebra-styles.css` y las variables CSS de
 *   Hebra (con el tema actual, y otra vez al cambiarlo) están en cada superficie, no en el
 *   marco de ejecución. Una superficie se mide sola: su tamaño es el del hueco que le da
 *   Hebra y, en un bloque de código o un modal, Hebra ajusta su alto al contenido.
 * - **Iconos y tooltips.** `setIcon(el, name)` pinta el glifo dentro del documento de
 *   `el`; `setTooltip(el, text)` lo enseña Hebra por encima de los marcos (no queda
 *   recortado por el borde de una superficie pequeña).
 * - **Clics de Hebra.** `ribbon`/`ribbonItem` reciben `PluginPointerInfo`;
 *   `openMenu` recibe `PluginMenuPosition`.
 * - **Síncrono.** Los registros devuelven su `PluginUnregister` en el acto y validan sus
 *   argumentos dentro del marco con las reglas de la 1.x (`invalid-argument` se lanza en
 *   síncrono, como hoy); lo que Hebra haga con ellos llega después por el puerto.
 */
export interface PluginUi {
  registerView(
    view: PluginViewDefinition | PluginMainViewDefinition | PluginTabViewDefinition
  ): PluginUnregister;
  revealView(id: string, options?: PluginRevealViewOptions): void;
  updateView(id: string, patch: PluginViewPatch): void;
  updateViewSection(viewId: string, sectionId: string, patch: PluginViewSectionPatch): void;
  registerCommand(command: PluginCommandDefinition): PluginUnregister;
  ribbon(item: PluginRibbonDefinition): PluginUnregister;
  ribbonItem(item: PluginRibbonDefinition): PluginRibbonHandle;
  settingsPanel(mount: PluginMountFn): PluginUnregister;
  openModal(mount: PluginMountFn, options?: PluginModalOptions): PluginModalHandle;
  notice(text: string, onClick?: () => void): void;
  setIcon(el: HTMLElement, name: string): void;
  setTooltip(el: HTMLElement, text: string): void;
  openMenu(items: readonly PluginMenuEntry[], position: PluginMenuPosition): void;
  openSettings(): void;
  registerStatusBarItem(item: PluginStatusBarItemDefinition): PluginStatusBarItemHandle;
  onReady(callback: () => void): PluginUnregister;
  /**
   * Abre `url` (`https:` o `http:`) en el navegador. La primera vez por dominio Hebra enseña la
   * URL y pide confirmación (P4, spec §5.5.2): `'cancelled'` si el usuario no la abre.
   */
  openExternal(url: string): Promise<'opened' | 'cancelled'>;
  pickFolder(): Promise<string | null>;
  /**
   * Desde la 2.2.0 (capacidad `screen.awake`: decláralo en `hebra.json`; comprueba antes
   * `api.has('screen.awake')`). Mismo comportamiento que `ui.keepScreenOn` de la 1.8: pide que
   * la pantalla NO se apague sola mientras la vista `viewId` (el `id` con el que la registraste,
   * de cualquier `placement`) esté a la vista. `on: true` lo pide y `on: false` lo suelta; es
   * idempotente y un `false` sobre una vista sin bloqueo resuelve `{ held: false }`.
   *
   * Solo existe en iPhone e iPad. En el resto, con la capacidad declarada, resuelve
   * `{ held: false }` sin lanzar (y `has('screen.awake')` da `false`). Sin declararla rechaza
   * con `capability-not-declared`; una vista que no es de este plugin, con `invalid-argument`.
   *
   * `held: true` = Hebra aceptó la petición; no dice que la pantalla esté bloqueada AHORA.
   * Hebra la suelta sola al cerrar la vista, al dejar de verse (y ANULA la petición: al volver
   * a mostrarla hay que pedirla de nuevo, p. ej. en `mount`) y al desactivar o descargar el
   * plugin. Con la app en segundo plano no se bloquea, y al volver con la vista aún visible se
   * re-aplica sola.
   */
  keepScreenOn(viewId: string, on: boolean): Promise<PluginKeepScreenOnResult>;
}

// ---- editor declarativo (capacidad `editor`, §6 y §8.5 de la spec) ----

/**
 * Aspecto de una decoración. Lo pinta HEBRA con sus propias clases
 * (`hebra-plugin-decoration hebra-plugin-decoration-<estilo>`): el plugin no pone CSS en
 * el editor, porque el editor está en el documento de Hebra y su hoja no llega ahí.
 */
export type PluginDecorationStyle = 'link' | 'accent' | 'muted' | 'warning' | 'danger';

/**
 * Un rango decorado del texto de la nota. `from` y `to` son posiciones del cuerpo ENTERO
 * (índices UTF-16, los de `String.prototype.slice`), con `from < to`, dentro del trozo que
 * se pidió. Hebra descarta en silencio las que no cumplan eso.
 */
export interface PluginDecoration {
  from: number;
  to: number;
  style: PluginDecorationStyle;
  /** Texto del tooltip (hasta 200 caracteres). */
  title?: string;
  /** `true`: el rango responde al clic (cursor de enlace y `onClick` del proveedor). */
  clickable?: boolean;
  /**
   * Desde la 2.1.0. Solo cuenta con `clickable: true`. Sin él, todo clic principal en el rango
   * se cancela y se entrega a `onClick` (el comportamiento de la 2.0.0). `'mod'`: solo se
   * cancela y se entrega el clic principal con el modificador primario (Cmd en macOS e iOS,
   * Ctrl en Linux y Windows; Alt y Mayús no cuentan y llegan en `pointer`); el clic simple no se toca y el editor pone el
   * cursor o selecciona como en cualquier texto. El plugin no puede decidirlo en `onClick`
   * (cruza al marco de forma asíncrona y para entonces el evento ya siguió su curso), por eso
   * se declara aquí. Cualquier otro valor se ignora, como un campo inválido.
   */
  clickModifier?: 'mod';
  /** Lo que vuelve en `onClick` para saber qué se pulsó (hasta 256 caracteres). */
  data?: string;
}

/**
 * Lo que Hebra pide a un proveedor de decoraciones: el texto de lo que se ve de la nota
 * (con un margen por arriba y por abajo), nunca el cuerpo entero si no hace falta.
 */
export interface PluginDecorationRequest {
  readonly noteId: string;
  /** Posición del cuerpo en la que empieza `text`. */
  readonly offset: number;
  /** `body.slice(offset, offset + text.length)`. */
  readonly text: string;
  /** Longitud del cuerpo entero. */
  readonly length: number;
}

/** Un clic en una decoración con `clickable: true`. */
export interface PluginDecorationClick {
  readonly noteId: string;
  readonly from: number;
  readonly to: number;
  readonly data: string | null;
  readonly pointer: PluginPointerInfo;
}

/**
 * Decoraciones calculadas por el plugin y pintadas por Hebra. Sustituye al `ViewPlugin`
 * con `posAtDOM` de la 1.x (lo que usa JDex para los números JD).
 *
 * - Hebra llama a `provide` al abrir la nota, al desplazarse y tras cada cambio del texto
 *   (agrupando cambios seguidos). Una respuesta que llega TARDE (tope de tiempo: 300 ms,
 *   medido en L6) o para un texto que ya cambió se descarta; hasta
 *   la siguiente, las decoraciones anteriores siguen, movidas con el texto.
 * - Como mucho 1000 decoraciones por respuesta; el resto se descarta.
 * - NUNCA en una nota protegida, tampoco desbloqueada (§8.5): ahí no se llama a `provide`.
 */
export interface PluginDecorationProvider {
  /** Único entre los proveedores del plugin. */
  id: string;
  provide(
    request: PluginDecorationRequest
  ): readonly PluginDecoration[] | Promise<readonly PluginDecoration[]>;
  onClick?(click: PluginDecorationClick): void;
}

/** Dónde está el cursor al pedir sugerencias. */
export interface PluginCompletionRequest {
  readonly noteId: string;
  /** Posición del cursor en el cuerpo. */
  readonly pos: number;
  /** La línea del cursor, entera. */
  readonly line: string;
  /** Posición del cuerpo en la que empieza `line`. */
  readonly lineFrom: number;
  /** `true` si el usuario las pidió con el atajo; `false` si salen al escribir. */
  readonly explicit: boolean;
}

export interface PluginCompletionOption {
  /** Lo que se ve en la lista (hasta 200 caracteres). */
  label: string;
  /** Segunda columna, en gris. */
  detail?: string;
  /** Lo que se escribe al elegirla; sin él, `label`. */
  apply?: string;
}

export interface PluginCompletionResult {
  /** Desde dónde se sustituye al elegir (en la línea del cursor). */
  from: number;
  /** Hasta dónde; sin él, el cursor. */
  to?: number;
  /** Como mucho 50; el resto se descarta. */
  options: readonly PluginCompletionOption[];
}

/**
 * Sugerencias al escribir, ejecutadas por Hebra con su autocompletado. Sustituye al
 * `EditorState.languageData` de la 1.x. Una respuesta que no llega en el tope (250 ms,
 * medido en L6) no se enseña. Nunca en una nota protegida.
 */
export interface PluginCompletionProvider {
  id: string;
  /** Caracteres que abren las sugerencias al escribirlos. Sin ellos, solo con el atajo. */
  triggers?: readonly string[];
  provide(
    request: PluginCompletionRequest
  ): PluginCompletionResult | null | Promise<PluginCompletionResult | null>;
}

/**
 * El editor de la 2.0: el plugin DICE qué decorar y qué sugerir y Hebra lo ejecuta en su
 * propio editor. El plugin no toca `EditorView`, ni prototipos, ni el DOM del editor.
 *
 * `registerCodeBlock` conserva su firma; `el` está en una superficie dentro del bloque y
 * Hebra ajusta su alto al contenido. Tampoco se monta en una nota protegida.
 */
export interface PluginEditor {
  registerDecorations(provider: PluginDecorationProvider): PluginUnregister;
  registerCompletion(provider: PluginCompletionProvider): PluginUnregister;
  registerCodeBlock(language: string, render: PluginCodeBlockRenderer): PluginUnregister;
}

// ---- storage servido por Hebra (§5.5.4 de la spec) ----

/**
 * Como en la 1.x: `get` es SÍNCRONO. En la 2.0 lee de un espejo que Hebra entrega al
 * arrancar el marco; `set` y `remove` cambian el espejo en el acto y Hebra lo guarda
 * después, en orden. Un cierre brusco puede perder lo último sin `flush`.
 */
export interface PluginDeviceStorage extends PluginDeviceStorageV1 {
  /** Resuelve cuando Hebra ha guardado todo lo escrito hasta ahora. */
  flush(): Promise<void>;
}

/**
 * - `settings`: igual que en la 1.x (asíncrono, por biblioteca).
 * - `device`: igual, con `flush`.
 * - `indexedDB`: una fábrica IndexedDB del plugin, con los datos guardados por HEBRA (no
 *   por el navegador). Úsala en lugar de `window.indexedDB`. Cumple el subconjunto de
 *   IndexedDB que usan hoy los plugins (almacenes, índices, cursores, `getAll`,
 *   `getAllKeys`, rangos, versiones). El `complete` de una transacción de escritura llega
 *   cuando Hebra ya lo ha guardado: es más lento que el nativo, pero no se pierde al
 *   cerrar.
 * - `IDBKeyRange`: el de esa fábrica (el del navegador no vale con ella).
 * - `indexedDbName(name)`: el mismo nombre que en la 1.x, para que los datos que Hebra
 *   traslada desde la 1.x (L14) se abran con el código de siempre.
 */
export interface PluginStorage {
  readonly settings: PluginSettingsStorage;
  readonly device: PluginDeviceStorage;
  readonly indexedDB: IDBFactory;
  readonly IDBKeyRange: typeof IDBKeyRange;
  indexedDbName(name: string): string;
}

// ---- portapapeles y sonido (requisitos 2 y 3 de Tyrian, plan C1 §7 bis) ----

/**
 * Escribir en el portapapeles desde un clic DENTRO de una superficie. Lo escribe Hebra, y
 * solo si su documento tiene la activación de ese gesto (el navegador la propaga del marco
 * a Hebra): sin gesto rechaza con `user-activation-required`. Siempre está (no se declara).
 * Leer el portapapeles no existe.
 */
export interface PluginClipboard {
  /** Texto plano, hasta 1 MiB (UTF-8; si no, `invalid-argument`). */
  writeText(text: string): Promise<void>;
}

/** Formatos de sonido que Hebra reproduce. */
export type PluginSoundMime = 'audio/wav' | 'audio/mpeg' | 'audio/ogg';

/** Lo que pasó con `notify.sound.play`. `muted`: el usuario silenció los sonidos. */
export type PluginSoundOutcome = 'played' | 'muted' | 'unavailable';

/**
 * Sonidos que reproduce HEBRA en su documento, también sin gesto reciente (capacidad
 * `notify.sound`). El plugin registra los bytes una vez (p. ej. un tono generado con un
 * `OfflineAudioContext`, que no necesita gesto) y después lo pide por su id.
 */
export interface PluginSoundPlayer {
  /** Hasta 512 KiB por sonido y 16 sonidos por plugin (borrador). */
  register(id: string, sound: { bytes: Uint8Array; mime: PluginSoundMime }): Promise<void>;
  /** `volume` de 0 a 1 (por defecto 1). */
  play(id: string, options?: { volume?: number }): Promise<PluginSoundOutcome>;
  unregister(id: string): Promise<void>;
}

/**
 * `system` como en la 1.x: síncrono, con el resultado según el permiso de la instantánea
 * (`pending` si todavía no se sabe). Desde la 2.0, `sound` (capacidad `notify.sound`).
 */
export interface PluginNotify extends PluginNotifyV1 {
  readonly sound: PluginSoundPlayer;
}

// ---- La API ----

/**
 * La API 2.0. Lo síncrono de la 1.x sigue siéndolo y se sirve de una instantánea que Hebra
 * entrega al arrancar el marco y mantiene al día con eventos por el puerto, ANTES de avisar
 * a los listeners (dentro de `onActiveNoteChange`, `workspace.activeNote()` ya es la
 * nueva):
 *
 * - `apiVersion`, `plugin`, `has()`, `env.*` (con sus `on…Change`), `vault.libraryId()`,
 *   `vault.rootFolderId()`, `workspace.activeNote()`, `storage.device.get`,
 *   `notify.system` y `markdown.*` (funciones puras que vienen dentro del arranque).
 *
 * Lo asíncrono va por el puerto con la misma forma de la 1.x. Las funciones que el plugin
 * pasa a Hebra (comandos, clics, listeners, guardias, `undo`) se quedan en el marco y Hebra
 * las llama por un id. Una guardia (`workspace.onBeforeFolderRename`) que no responde en el
 * tope (borrador: 2 s) cuenta como `true` y se anota con el id del plugin.
 *
 * Los valores cruzan por clonado estructurado: lo que se pasa a Hebra tiene que poder
 * clonarse (sin funciones salvo donde la firma las pide, sin nodos del DOM salvo
 * `PluginMenuPosition.element`, que el arranque traduce a coordenadas). Un `Uint8Array`
 * se TRANSFIERE: tras `vault.blobPut(bytes)` o `notify.sound.register`, `bytes` queda
 * vacío en el plugin.
 */
export interface HebraPluginApi {
  /** La que implementa Hebra, p. ej. `'2.0.0'`. */
  readonly apiVersion: string;
  readonly plugin: { readonly id: string; readonly version: string };
  has(capability: PluginCapability | PluginHostFeature): boolean;
  /** `true` si `error` es un error de la API (y, con `code`, de ese código). En la 1.x era
   *  la función `isPluginApiError` del paquete. */
  isError(error: unknown, code?: PluginApiErrorCode): error is PluginApiErrorShape;
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
  readonly clipboard: PluginClipboard;
  readonly background: PluginBackground;
}

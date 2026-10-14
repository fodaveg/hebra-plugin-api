/**
 * Protocolo entre Hebra y el arranque de un marco de plugin 2.0: lotes L1 (forma), L3
 * (handshake y ciclo de vida) y L4 (la API por RPC) del plan C1
 * (`docs/SPEC-PLUGINS-EXTERNOS.md` §5.5.3). Casi todo son tipos; los únicos valores son
 * `PLUGIN_FRAME_SUBSCRIBABLE_TOPICS` y `PLUGIN_FRAME_NOT_YET_SERVED`, que usan los dos lados.
 *
 * Los dos extremos son código de HEBRA: el anfitrión (`PluginFrameHost`, L3) en el
 * documento de Hebra y el arranque que Hebra sirve dentro del origen del plugin. Un plugin
 * no lo usa: usa `HebraPluginApi` (`./index.ts`), que el arranque construye encima del
 * puerto. Vive en el paquete para que anfitrión, arranque y host falso compartan la forma.
 *
 * Handshake (L3):
 *
 * 1. Hebra crea el marco (`sandbox="allow-scripts allow-same-origin"`) con una URL del
 *    origen del plugin. El arranque, al cargar, manda `PluginFrameHello` a `parent` por
 *    `postMessage`, con el origen de Hebra como destino.
 * 2. Hebra solo lo acepta si `event.source === marco.contentWindow` Y `event.origin` es
 *    EXACTAMENTE el origen de ese plugin. Si no, lo ignora sin responder.
 * 3. Hebra crea un `MessageChannel` y manda `PluginFramePortGrant` a ese marco, con el
 *    origen del plugin como destino y un extremo del canal transferido. Desde ahí, todo va
 *    por el puerto: Hebra no vuelve a leer `postMessage` de ese marco.
 * 4. El id del plugin lo fija HEBRA por el puerto (sabe a qué marco lo dio); ningún mensaje
 *    lo trae ni se le hace caso si lo trae (cierra M1 del audit con L4).
 *
 * Un puerto por marco: el de ejecución y cada superficie tienen el suyo.
 *
 * Por el puerto (L4): el marco llama con `call` (`PluginFrameRpc`); cada función que el plugin
 * pasa se queda en el marco y cruza como `PluginCallbackRef` (`PluginWire`); Hebra la llama con
 * `callback`. Los registros llevan un número de ASA que pone el marco, porque en el marco
 * devuelven su baja en el acto (`handle.release`). Los cambios llegan con `event`
 * (`PluginFrameTopics`).
 */
import type {
  PluginActiveNote,
  PluginCommandDefinition,
  PluginFolder,
  PluginFolderRenameEvent,
  PluginHostFeature,
  PluginHttp,
  PluginJsonValue,
  PluginMenuEntry,
  PluginNotesChange,
  PluginNoteTitleRenamedEvent,
  PluginPlatform,
  PluginSecrets,
  PluginStatusBarItemDefinition,
  PluginSystemNotificationOutcome,
  PluginSystemNotifyInput,
  PluginTcp,
  PluginViewSection,
  PluginTcpEvent,
  PluginVault,
  PluginVaultChange,
  PluginWorkspace,
  PluginBackground
} from './_v1/index';
import type {
  PluginApiErrorShape,
  PluginCapability,
  PluginCompletionProvider,
  PluginCompletionRequest,
  PluginDecorationClick,
  PluginDecorationProvider,
  PluginDecorationRequest,
  PluginPointerInfo,
  PluginRibbonDefinition,
  PluginUi
} from './index';

/** Versión de este protocolo (no de la API). */
export type PluginFrameProtocolVersion = 1;

/**
 * `runtime`: el marco oculto donde corre el plugin. `surface`: un marco donde el plugin
 * monta una vista, un panel, un modal o un bloque de código.
 */
export type PluginFrameRole = 'runtime' | 'surface';

/** Paso 1: el marco se presenta. */
export interface PluginFrameHello {
  readonly type: 'hebra-plugin/hello';
  readonly protocol: PluginFrameProtocolVersion;
  readonly role: PluginFrameRole;
  /** Solo en una superficie: el id que Hebra puso en su URL. */
  readonly surfaceId?: string;
}

/** Paso 3: Hebra entrega el puerto (en `event.ports[0]`). */
export interface PluginFramePortGrant {
  readonly type: 'hebra-plugin/port';
  readonly protocol: PluginFrameProtocolVersion;
}

/** Permiso de avisos del sistema tal como lo ve Hebra (lo que decide `notify.system`). */
export type PluginNotifyPermission = 'granted' | 'denied' | 'default' | 'unavailable';

/**
 * Lo que Hebra entrega al marco de ejecución nada más abrir el puerto, antes de
 * `activate`. De aquí salen los getters síncronos de la API; los eventos lo mantienen.
 */
export interface PluginBootSnapshot {
  readonly apiVersion: string;
  readonly plugin: { readonly id: string; readonly version: string };
  /** Respuesta de `has()` para cada capacidad y función del anfitrión que Hebra conoce;
   *  lo que no está, `false`. */
  readonly has: Readonly<Partial<Record<PluginCapability | PluginHostFeature, boolean>>>;
  readonly env: {
    readonly platform: PluginPlatform;
    readonly isDesktopApp: boolean;
    readonly hostVersion: string;
    readonly locale: string;
    readonly online: boolean;
    readonly visible: boolean;
    readonly appleMobile: boolean;
    readonly isoDates: boolean;
  };
  readonly vault: { readonly libraryId: string; readonly rootFolderId: string };
  readonly activeNote: PluginActiveNote | null;
  /** El espejo de `storage.device`: clave → valor ya leído (lo llena L14). */
  readonly device: Readonly<Record<string, PluginJsonValue>>;
  readonly notifyPermission: PluginNotifyPermission;
  /**
   * L4: por qué una capacidad NO está, con el error que daría la fachada de Hebra
   * (`capability-not-declared`, `unavailable-on-platform`, `capability-not-available`).
   * Lo usan los métodos SÍNCRONOS que piden capacidad (`vault.libraryId`,
   * `vault.rootFolderId`, `vault.onChange`, `notify.system`): lanzan en el acto, como en la
   * 1.x, sin esperar al puerto. Lo asíncrono lo decide Hebra en cada llamada.
   */
  readonly capabilityErrors: Readonly<Partial<Record<PluginCapability, PluginApiErrorShape>>>;
}

/** Una función que el plugin pasó a Hebra: se queda en el marco y Hebra la nombra así. */
export interface PluginCallbackRef {
  readonly callback: number;
}

/**
 * Un error que NO es de la API (un fallo de Hebra o del sistema) tal como cruza el puerto:
 * nombre y texto acotados, nunca el objeto. `api.isError` da `false` con él.
 */
export interface PluginFrameForeignError {
  readonly name: string;
  readonly message: string;
}

/** Lo que cruza el puerto como error: el de la API o uno ajeno. */
export type PluginFrameErrorShape = PluginApiErrorShape | PluginFrameForeignError;

// ---- L4: la API por RPC (spec §5.5.3) ----

/**
 * Cómo viaja por el puerto un valor de la API: cada FUNCIÓN se queda en el marco y cruza su
 * `PluginCallbackRef`; lo demás, por clonado estructurado (los bytes, tal cual).
 */
export type PluginWire<T> = T extends (...args: never[]) => unknown
  ? PluginCallbackRef
  : T extends Uint8Array | ArrayBuffer
    ? T
    : T extends object
      ? { readonly [K in keyof T]: PluginWire<T[K]> }
      : T;

/** Un método asíncrono de la API, tal cual: sus argumentos por el puerto y su resultado. */
type Rpc<F> = F extends (...args: infer A) => infer R
  ? { readonly args: PluginWire<A>; readonly result: Awaited<R> }
  : never;

/** Un método que no devuelve nada (`openNote`, `notice`…): Hebra responde `null`. */
type Fire<F> = F extends (...args: infer A) => unknown
  ? { readonly args: PluginWire<A>; readonly result: null }
  : never;

/**
 * Un registro: en el marco devuelve su baja en el acto (`PluginUnregister` o un asa); por el
 * puerto va con un número de asa que pone el MARCO (`handle.release` y `handle.update` lo
 * usan) y Hebra responde `null` o el error de su registro.
 */
type Register<T> = {
  readonly args: readonly [handle: number, item: PluginWire<T>];
  readonly result: null;
};

/** Cambios de un asa (`ribbonItem` y `registerStatusBarItem`). */
export type PluginFrameHandlePatch =
  | PluginWire<Partial<Omit<PluginRibbonDefinition, 'onClick' | 'viewId'>>>
  | PluginWire<Partial<Omit<PluginStatusBarItemDefinition, 'id'>>>;

/** `onNoteTitleRenamed` por el puerto: `undo` es un número que Hebra entiende. */
export type PluginFrameTitleRenamed = Omit<PluginNoteTitleRenamedEvent, 'undo'> & {
  readonly undo: number;
};

/**
 * La nota activa por el puerto. `snapshot` es lo que devuelve `activeNote()` para ESTE plugin
 * (con la nota fijada de T10, spec §5.5.5); si trae `changed`, además hay que avisar a los
 * listeners con ese valor (el cambio de verdad, como en la 1.x).
 */
export type PluginFrameActiveNoteEvent =
  | { readonly snapshot: PluginActiveNote | null }
  | { readonly snapshot: PluginActiveNote | null; readonly changed: PluginActiveNote | null };

/**
 * Temas de `event`, con su carga. Los de la instantánea (`env.*`, `workspace.activeNote`,
 * `notify.permission`) llegan siempre; los demás, solo tras `events.subscribe`.
 */
export interface PluginFrameTopics {
  readonly 'env.online': boolean;
  readonly 'env.visible': boolean;
  readonly 'env.isoDates': boolean;
  readonly 'workspace.activeNote': PluginFrameActiveNoteEvent;
  readonly 'notify.permission': PluginNotifyPermission;
  readonly 'workspace.folders': readonly PluginFolder[];
  readonly 'workspace.notes': PluginNotesChange;
  readonly 'workspace.noteTitleRenamed': PluginFrameTitleRenamed;
  readonly 'vault.change': PluginVaultChange;
  readonly 'storage.settings': unknown;
}
export type PluginFrameTopic = keyof PluginFrameTopics;

/** Los temas que el marco pide con `events.subscribe` (los demás llegan siempre). */
export const PLUGIN_FRAME_SUBSCRIBABLE_TOPICS = [
  'workspace.folders',
  'workspace.notes',
  'workspace.noteTitleRenamed',
  'vault.change',
  'storage.settings'
] as const satisfies readonly PluginFrameTopic[];
export type PluginFrameSubscribableTopic = (typeof PLUGIN_FRAME_SUBSCRIBABLE_TOPICS)[number];

/**
 * Capacidades y funciones del anfitrión que el marco todavía NO da. `has()` las da por `false`
 * aunque estén declaradas, para no prometer lo que el marco no sirve. L5 quitó `notify.sound` y
 * `ui.view.main` (vistas `main`, sonido) y L6 quitó `editor`. Solo queda `ui.view.tab`: las vistas
 * de pestaña no entraron en L5.
 */
export const PLUGIN_FRAME_NOT_YET_SERVED = ['ui.view.tab'] as const satisfies readonly (
  PluginCapability | PluginHostFeature
)[];

// ---- L5: superficies ----

/**
 * Dónde está una superficie para el marco de ejecución: Hebra crea el marco de superficie
 * (hermano del de ejecución, mismo origen) y dice su número en `window.frames` de Hebra
 * (`frame`); el marco de ejecución llega a él con `parent.frames[frame]` y comprueba que
 * `documentElement.dataset.hebraSurface === surfaceId`.
 */
export interface PluginSurfaceTicket {
  readonly surfaceId: string;
  readonly frame: number;
}

/** Contexto de un bloque de código (el de la 1.x, serializable). */
export interface PluginSurfaceCodeBlock {
  readonly source: string;
  readonly language: string;
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
}

/**
 * Lo que Hebra pide al marco de ejecución sobre una superficie, con `callback` (una sola
 * función por registro, la que crea `createFrameApi`).
 *
 * - `mount`: monta lo del plugin en la superficie (`mount(el)`, `mountSection(el, id)`,
 *   `render(el, source, ctx)`). Resuelve cuando el plugin ha montado; si lanza, Hebra lo anota.
 * - `visible`: solo `retainSections`.
 * - `unmount`: limpieza (la que devolvió el plugin) y `unmount()` de la vista.
 */
export type PluginSurfaceCall =
  | {
      readonly op: 'mount';
      readonly ticket: PluginSurfaceTicket;
      readonly section?: string;
      readonly code?: PluginSurfaceCodeBlock;
    }
  | { readonly op: 'visible'; readonly surfaceId: string; readonly visible: boolean }
  | { readonly op: 'unmount'; readonly surfaceId: string };

/** Una vista por el puerto: `surface` es la función única que Hebra llama con `PluginSurfaceCall`. */
export interface PluginFrameViewWire {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly placement?: 'column' | 'dialog' | 'main';
  readonly sections?: readonly PluginViewSection[];
  readonly retainSections?: boolean;
  readonly surface: PluginCallbackRef;
}

export interface PluginFrameModalWire {
  readonly title?: string;
  readonly onClosed?: PluginCallbackRef;
}

/** Posición de `ui.openMenu` por el puerto; `surface` es la superficie de `element`. */
export interface PluginFrameMenuPosition {
  readonly x: number;
  readonly y: number;
  readonly surface?: string;
}

/** Rectángulo de un elemento de una superficie, en coordenadas de esa superficie. */
export interface PluginSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Entre Hebra y un marco de SUPERFICIE (cada uno con su puerto; handshake como el del marco de
 * ejecución, con `role: 'surface'` y `surfaceId` en el `hello`).
 *
 * - Hebra → superficie: `style` (variables CSS y tema, otra vez al cambiar de tema), `focus`.
 * - Superficie → Hebra: `ready` (ya aplicó el estilo), `size` (alto del contenido, en las
 *   superficies que se ajustan a él), `key` (un atajo de Hebra pulsado con el foco dentro) y
 *   `focus-out` (Tab/Shift-Tab fuera del primero/último).
 */
export type PluginHostToSurface =
  | {
      readonly type: 'style';
      readonly variables: Readonly<Record<string, string>>;
      readonly mode: 'light' | 'dark';
      readonly theme: string;
    }
  | { readonly type: 'focus' }
  | { readonly type: 'dispose' };

export interface PluginSurfaceKey {
  readonly key: string;
  readonly code: string;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly repeat: boolean;
}

export type PluginSurfaceToHost =
  | { readonly type: 'ready' }
  | { readonly type: 'size'; readonly height: number }
  | { readonly type: 'key'; readonly key: PluginSurfaceKey };

/**
 * Los métodos de `call` que sirve Hebra en la 2.0 (L4), con sus argumentos y su resultado
 * por el puerto. Sale de los tipos de la API (`./index.ts`): si uno cambia, el anfitrión
 * (`src/lib/plugins/api/frame-facade.ts` y `./host-dispatch.ts`) y el marco
 * (`./frame-api.ts`) dejan de compilar (test de contrato).
 *
 * Lo síncrono que sale de la instantánea (`env.*`, `vault.libraryId`, `activeNote()`…) no
 * está: no se pregunta. Lo que necesita superficie (vistas, modal, panel, iconos, editor),
 * portapapeles, sonido y `openExternal` (P4) es de L5/L6; el almacenamiento del dispositivo
 * e IndexedDB, de L14 (sus espacios se enchufan aparte, ver `PluginFrameNamespaceHandlers`).
 */
export interface PluginFrameRpc {
  readonly 'handle.release': { readonly args: readonly [handle: number]; readonly result: null };
  readonly 'handle.update': {
    readonly args: readonly [handle: number, patch: PluginFrameHandlePatch];
    readonly result: null;
  };
  readonly 'events.subscribe': {
    readonly args: readonly [topic: PluginFrameSubscribableTopic];
    readonly result: null;
  };
  readonly 'events.unsubscribe': {
    readonly args: readonly [topic: PluginFrameSubscribableTopic];
    readonly result: null;
  };

  readonly 'ui.revealView': Fire<PluginUi['revealView']>;
  readonly 'ui.updateView': Fire<PluginUi['updateView']>;
  readonly 'ui.updateViewSection': Fire<PluginUi['updateViewSection']>;
  readonly 'ui.registerCommand': Register<PluginCommandDefinition>;
  readonly 'ui.ribbon': Register<PluginRibbonDefinition>;
  readonly 'ui.ribbonItem': Register<PluginRibbonDefinition>;
  readonly 'ui.registerStatusBarItem': Register<PluginStatusBarItemDefinition>;
  readonly 'ui.onReady': Register<() => void>;
  readonly 'ui.notice': Fire<PluginUi['notice']>;
  /** Con `surface` (L5): coordenadas del documento de esa superficie; Hebra suma su posición. */
  readonly 'ui.openMenu': {
    readonly args: readonly [
      items: PluginWire<readonly PluginMenuEntry[]>,
      position: PluginFrameMenuPosition
    ];
    readonly result: null;
  };
  readonly 'ui.registerView': Register<PluginFrameViewWire>;
  readonly 'ui.settingsPanel': Register<{ readonly surface: PluginCallbackRef }>;
  /** El asa cierra el modal (`handle.release`); `onClosed` avisa también si lo cierra la persona. */
  readonly 'ui.openModal': {
    readonly args: readonly [
      handle: number,
      surface: PluginCallbackRef,
      options: PluginFrameModalWire | undefined
    ];
    readonly result: null;
  };
  readonly 'editor.registerCodeBlock': {
    readonly args: readonly [handle: number, language: string, surface: PluginCallbackRef];
    readonly result: null;
  };
  /** Un tooltip que Hebra pinta por encima de los marcos; `text: null` lo quita. */
  readonly 'ui.tooltip': {
    readonly args: readonly [
      surfaceId: string,
      text: string | null,
      rect: PluginSurfaceRect | null
    ];
    readonly result: null;
  };
  readonly 'ui.openExternal': {
    readonly args: readonly [url: string];
    readonly result: 'opened' | 'cancelled';
  };
  readonly 'clipboard.writeText': { readonly args: readonly [text: string]; readonly result: null };
  readonly 'notify.sound.register': {
    readonly args: readonly [id: string, sound: { bytes: Uint8Array; mime: string }];
    readonly result: null;
  };
  readonly 'notify.sound.play': {
    readonly args: readonly [id: string, options: { volume?: number } | undefined];
    readonly result: 'played' | 'muted' | 'unavailable';
  };
  readonly 'notify.sound.unregister': {
    readonly args: readonly [id: string];
    readonly result: null;
  };
  readonly 'ui.openSettings': Fire<PluginUi['openSettings']>;
  readonly 'ui.pickFolder': Rpc<PluginUi['pickFolder']>;
  /** Desde la 2.2.0 (`screen.awake`): Hebra aplica la petición con el controlador de la 1.8. */
  readonly 'ui.keepScreenOn': Rpc<PluginUi['keepScreenOn']>;

  /**
   * El editor declarativo (L6, spec §6.1): Hebra llama a `provide` por el puerto
   * (`PluginFrameCallbackArgs.decorations` y `.completion`, con respuesta) y ejecuta el
   * resultado en SU editor. Nunca en una nota protegida.
   */
  readonly 'editor.registerDecorations': Register<PluginDecorationProvider>;
  readonly 'editor.registerCompletion': Register<PluginCompletionProvider>;

  readonly 'vault.notesPage': Rpc<PluginVault['notesPage']>;
  readonly 'vault.noteRead': Rpc<PluginVault['noteRead']>;
  readonly 'vault.noteSummary': Rpc<PluginVault['noteSummary']>;
  readonly 'vault.noteCreate': Rpc<PluginVault['noteCreate']>;
  readonly 'vault.noteSave': Rpc<PluginVault['noteSave']>;
  readonly 'vault.notesRewriteBatch': Rpc<PluginVault['notesRewriteBatch']>;
  readonly 'vault.noteMove': Rpc<PluginVault['noteMove']>;
  readonly 'vault.noteMoveIfUnchanged': Rpc<PluginVault['noteMoveIfUnchanged']>;
  readonly 'vault.noteTrash': Rpc<PluginVault['noteTrash']>;
  readonly 'vault.noteTrashIfUnchanged': Rpc<PluginVault['noteTrashIfUnchanged']>;
  readonly 'vault.noteRestore': Rpc<PluginVault['noteRestore']>;
  readonly 'vault.noteRestoreIfUnchanged': Rpc<PluginVault['noteRestoreIfUnchanged']>;
  readonly 'vault.foldersList': Rpc<PluginVault['foldersList']>;
  readonly 'vault.folderCreate': Rpc<PluginVault['folderCreate']>;
  readonly 'vault.folderRename': Rpc<PluginVault['folderRename']>;
  readonly 'vault.folderRenameIfUnchanged': Rpc<PluginVault['folderRenameIfUnchanged']>;
  readonly 'vault.folderMove': Rpc<PluginVault['folderMove']>;
  readonly 'vault.folderMoveIfUnchanged': Rpc<PluginVault['folderMoveIfUnchanged']>;
  readonly 'vault.folderTrashEmpty': Rpc<PluginVault['folderTrashEmpty']>;
  readonly 'vault.filesPage': Rpc<PluginVault['filesPage']>;
  readonly 'vault.fileRead': Rpc<PluginVault['fileRead']>;
  readonly 'vault.fileCreate': Rpc<PluginVault['fileCreate']>;
  readonly 'vault.fileReplace': Rpc<PluginVault['fileReplace']>;
  readonly 'vault.fileTrash': Rpc<PluginVault['fileTrash']>;
  readonly 'vault.blobRead': Rpc<PluginVault['blobRead']>;
  readonly 'vault.blobPut': Rpc<PluginVault['blobPut']>;

  readonly 'workspace.openNote': Fire<PluginWorkspace['openNote']>;
  readonly 'workspace.selectFolder': Fire<PluginWorkspace['selectFolder']>;
  readonly 'workspace.openSearch': Fire<PluginWorkspace['openSearch']>;
  readonly 'workspace.restart': Rpc<PluginWorkspace['restart']>;
  readonly 'workspace.onBeforeFolderRename': Register<
    (event: PluginFolderRenameEvent) => Promise<boolean>
  >;
  /** `undo()` de un `onNoteTitleRenamed`, por el número que trajo el evento. */
  readonly 'workspace.undoTitleRename': {
    readonly args: readonly [undo: number];
    readonly result: null;
  };

  readonly 'storage.settings.load': { readonly args: readonly []; readonly result: unknown };
  readonly 'storage.settings.save': {
    readonly args: readonly [value: unknown];
    readonly result: null;
  };

  readonly 'http.request': Rpc<PluginHttp['request']>;
  readonly 'http.requestUserHost': Rpc<PluginHttp['requestUserHost']>;
  readonly 'secrets.get': Rpc<PluginSecrets['get']>;
  readonly 'secrets.set': Rpc<PluginSecrets['set']>;
  readonly 'secrets.clear': Rpc<PluginSecrets['clear']>;
  readonly 'tcp.listen': {
    readonly args: readonly [port: number, onEvent: PluginCallbackRef];
    readonly result: number;
  };
  readonly 'tcp.write': Rpc<PluginTcp['write']>;
  readonly 'tcp.end': Rpc<PluginTcp['end']>;
  readonly 'tcp.destroy': Rpc<PluginTcp['destroy']>;
  readonly 'tcp.close': Rpc<PluginTcp['close']>;
  readonly 'notify.system': {
    readonly args: readonly [input: PluginSystemNotifyInput];
    readonly result: PluginSystemNotificationOutcome;
  };
  readonly 'background.hold': Rpc<PluginBackground['hold']>;
  readonly 'background.release': Rpc<PluginBackground['release']>;
}
export type PluginFrameMethod = keyof PluginFrameRpc;

/** Lo que Hebra pasa a cada `callback` que llama, por tipo de función (para los dos lados). */
export interface PluginFrameCallbackArgs {
  readonly command: readonly [];
  readonly ribbon: readonly [pointer?: PluginPointerInfo];
  readonly menu: readonly [];
  readonly notice: readonly [];
  readonly statusBar: readonly [];
  readonly ready: readonly [];
  readonly guard: readonly [event: PluginFolderRenameEvent];
  readonly tcp: readonly [event: PluginTcpEvent];
  readonly surface: readonly [call: PluginSurfaceCall];
  readonly modalClosed: readonly [];
  /** `provide` de decoraciones: responde con la lista de rangos (la valida Hebra). */
  readonly decorations: readonly [request: PluginDecorationRequest];
  readonly decorationClick: readonly [click: PluginDecorationClick];
  /** `provide` de sugerencias: responde con el resultado o `null` (lo valida Hebra). */
  readonly completion: readonly [request: PluginCompletionRequest];
}

/**
 * Métodos de otro lote que se sirven por el mismo puerto con su propio espacio
 * (`storage.device.*`, `storage.indexedDB.*`: L14). Cada uno recibe los argumentos tal como
 * llegaron (NO son de fiar: los valida él) y devuelve el resultado o lanza.
 */
export type PluginFrameNamespaceHandlers = Readonly<
  Record<string, (args: readonly unknown[]) => unknown>
>;

/** Nombre de un método de un espacio enchufado: `<espacio>.<método>`. */
export type PluginFrameExtensionMethod = `${string}.${string}`;

/**
 * Del marco a Hebra.
 *
 * - `call`: un método de la API, con nombre `<espacio>.<método>` (`vault.noteRead`,
 *   `ui.registerCommand`…). En `args`, cada función va como `PluginCallbackRef`.
 * - `callback-result` / `callback-error`: respuesta a un `callback` de Hebra (una guardia,
 *   un `provide` del editor).
 * - `surface-size`: una superficie dice el alto de su contenido (bloque de código, modal).
 */
export type PluginFrameToHost =
  | {
      readonly type: 'call';
      readonly id: number;
      readonly method: string;
      readonly args: readonly unknown[];
    }
  | { readonly type: 'callback-result'; readonly id: number; readonly value: unknown }
  | { readonly type: 'callback-error'; readonly id: number; readonly error: PluginFrameErrorShape }
  | { readonly type: 'surface-size'; readonly surfaceId: string; readonly height: number };

/**
 * De Hebra al marco.
 *
 * - `boot`: la instantánea, una vez, al abrir el puerto.
 * - `result` / `error`: respuesta a un `call`.
 * - `event`: un cambio (`env.online`, `workspace.activeNote`, `vault.change`, `tcp`…). El
 *   arranque actualiza la instantánea y después avisa a los listeners.
 * - `callback`: Hebra llama a una función del plugin; si espera respuesta, `id` la pide.
 * - `dispose`: el plugin se apaga; el arranque llama a su limpieza y cierra el puerto.
 */
export type PluginHostToFrame =
  | { readonly type: 'boot'; readonly snapshot: PluginBootSnapshot }
  | { readonly type: 'result'; readonly id: number; readonly value: unknown }
  | { readonly type: 'error'; readonly id: number; readonly error: PluginFrameErrorShape }
  | { readonly type: 'event'; readonly topic: string; readonly payload: unknown }
  | {
      readonly type: 'callback';
      readonly callback: number;
      readonly args: readonly unknown[];
      /** Presente si Hebra espera `callback-result` con este id. */
      readonly id?: number;
    }
  | { readonly type: 'dispose' };

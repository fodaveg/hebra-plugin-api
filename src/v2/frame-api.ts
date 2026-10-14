/**
 * El lado del MARCO de la API 2.0 (lote L4 del plan C1; contrato en
 * `docs/SPEC-PLUGINS-EXTERNOS.md` §5.5.3-§5.5.5; protocolo en `./protocol.ts`).
 *
 * Es código de HEBRA, no del plugin: lo usan el arranque del marco
 * (`src/lib/plugins/frame/frame-boot.ts`, que Hebra sirve en el origen del plugin) y el host
 * falso (`./testing.ts`). Vive en el paquete para que los dos den EXACTAMENTE la misma API:
 * un plugin probado con el host falso se comporta igual en el marco.
 *
 * Dos piezas:
 *
 * - `PluginFrameClient`: el puerto. Llamadas con `call` y su respuesta, las funciones del
 *   plugin que Hebra llama por un número (`callback`), los eventos (`event`) y el apagado.
 * - `createFrameApi`: el `HebraPluginApi` de la 2.0 encima del cliente. Lo síncrono sale de la
 *   instantánea (`PluginBootSnapshot`), que los eventos mantienen al día ANTES de avisar a los
 *   listeners; lo asíncrono va por el puerto con la forma de la 1.x.
 *
 * Lo que todavía no da (lo dice con `capability-not-available`, que es lo que un plugin
 * escrito para la 2.0 tiene que saber manejar en un Hebra que no lo tiene):
 *
 * - Superficies (L5): las da `options.surfaces` (el arranque de Hebra; el host falso no lo
 *   tiene y ahí responden `capability-not-available`). Siguen sin dar: las vistas de pestaña,
 *   y `workspace.openView`.
 * - Almacenamiento servido por Hebra (L14): `storage.device` y `storage.indexedDB`, salvo que
 *   el arranque enchufe sus proveedores (`PluginFrameExtensions`).
 */
import type {
  PluginActiveNote,
  PluginBackground,
  PluginMainViewDefinition,
  PluginModalHandle,
  PluginModalOptions,
  PluginMountFn,
  PluginViewDefinition,
  PluginViewSectionMount,
  PluginCodeBlockRenderer,
  PluginCommandDefinition,
  PluginEnv,
  PluginFolder,
  PluginFolderRenameEvent,
  PluginFolderRenameGuard,
  PluginHttp,
  PluginMarkdown,
  PluginMenuEntry,
  PluginNotesChange,
  PluginNoteTitleRenamedEvent,
  PluginSecrets,
  PluginSettingsStorage,
  PluginStatusBarItemDefinition,
  PluginStatusBarItemHandle,
  PluginSystemNotificationOutcome,
  PluginSystemNotifyInput,
  PluginTcp,
  PluginTcpEvent,
  PluginUnregister,
  PluginVault,
  PluginVaultChange,
  PluginWorkspace
} from './_v1/index';
import {
  isPluginApiError,
  type HebraPluginApi,
  type PluginApiErrorShape,
  type PluginCapability,
  type PluginClipboard,
  type PluginCompletionProvider,
  type PluginDecorationProvider,
  type PluginDeviceStorage,
  type PluginEditor,
  type PluginHostFeature,
  type PluginMenuPosition,
  type PluginNotify,
  type PluginPointerInfo,
  type PluginRibbonDefinition,
  type PluginRibbonHandle,
  type PluginSoundPlayer,
  type PluginStorage,
  type PluginUi
} from './index';
import {
  PLUGIN_FRAME_SUBSCRIBABLE_TOPICS,
  type PluginBootSnapshot,
  type PluginCallbackRef,
  type PluginFrameActiveNoteEvent,
  type PluginFrameMethod,
  type PluginFrameRpc,
  type PluginFrameSubscribableTopic,
  type PluginFrameTitleRenamed,
  type PluginFrameToHost,
  type PluginFrameTopic,
  type PluginSurfaceCall,
  type PluginSurfaceRect,
  type PluginSurfaceTicket,
  type PluginFrameTopics,
  type PluginHostToFrame,
  type PluginNotifyPermission
} from './protocol';
import { PLUGIN_EDITOR_LIMITS } from './editor';
import { frameApiError, frameError, serializeFrameError } from './wire';

export { frameApiError, frameError, serializeFrameError } from './wire';

function notYet(what: string): Error {
  return frameApiError(
    'capability-not-available',
    `${what}: esta versión de Hebra todavía no lo ofrece a los plugins 2.0.`
  );
}

// ---- El puerto ----

/** Lo que el cliente necesita del `MessagePort` (el arranque le pasa el real). */
export interface PluginFramePortLike {
  postMessage(message: PluginFrameToHost, transfer?: Transferable[]): void;
  close(): void;
}

export interface PluginFrameClientHooks {
  /** La instantánea, una vez. */
  boot(snapshot: PluginBootSnapshot): void;
  /** Hebra apaga el plugin: el arranque corre su limpieza y llama a `client.close()`. */
  dispose(): void;
}

type AnyFunction = (...args: never[]) => unknown;

/**
 * El extremo del marco del puerto. No sabe nada de la API: llama, guarda funciones por número,
 * reparte eventos y cierra. Lo que llega antes de `boot` (salvo respuestas) se descarta: la
 * instantánea ya lo incluye.
 */
export class PluginFrameClient {
  readonly #port: PluginFramePortLike;
  readonly #hooks: PluginFrameClientHooks;
  #nextCall = 1;
  #nextCallback = 1;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  readonly #callbacks = new Map<number, AnyFunction>();
  /** Los callbacks cuya respuesta es un dato estructurado (`provide` del editor). */
  readonly #dataCallbacks = new Set<number>();
  readonly #topics = new Map<string, Set<(payload: unknown) => void>>();
  #booted = false;
  #closed = false;

  constructor(port: PluginFramePortLike, hooks: PluginFrameClientHooks) {
    this.#port = port;
    this.#hooks = hooks;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Lo que llega por el puerto (el arranque lo engancha a `port.onmessage`). */
  receive(data: unknown): void {
    if (this.#closed || typeof data !== 'object' || data === null) return;
    const message = data as PluginHostToFrame;
    switch (message.type) {
      case 'boot':
        if (this.#booted) return;
        this.#booted = true;
        this.#hooks.boot(message.snapshot);
        return;
      case 'result':
      case 'error': {
        const entry = this.#pending.get(message.id);
        if (!entry) return;
        this.#pending.delete(message.id);
        if (message.type === 'result') entry.resolve(message.value);
        else entry.reject(frameError(message.error));
        return;
      }
      case 'event':
        if (!this.#booted) return;
        for (const listener of [...(this.#topics.get(message.topic) ?? [])])
          listener(message.payload);
        return;
      case 'callback':
        this.#runCallback(message.callback, message.args, message.id);
        return;
      case 'dispose':
        this.#hooks.dispose();
        return;
      default:
        return;
    }
  }

  /** Un método de la API por el puerto, con sus tipos. */
  rpc<M extends PluginFrameMethod>(
    method: M,
    args: PluginFrameRpc[M]['args'],
    transfer?: Transferable[]
  ): Promise<PluginFrameRpc[M]['result']> {
    return this.call(method, args, transfer) as Promise<PluginFrameRpc[M]['result']>;
  }

  /** Cualquier método (`runtime.*` del ciclo de vida o un espacio enchufado, L14). */
  call(method: string, args: readonly unknown[], transfer?: Transferable[]): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(frameApiError('plugin-disposed', `${method}: el plugin está apagado.`));
    }
    return new Promise((resolve, reject) => {
      const id = this.#nextCall++;
      this.#pending.set(id, { resolve, reject });
      try {
        this.#port.postMessage({ type: 'call', id, method, args }, transfer);
      } catch (error) {
        // Un argumento que no se puede clonar (una función donde no va, un nodo): es del
        // plugin, así que lo dice como argumento inválido.
        this.#pending.delete(id);
        reject(
          frameApiError(
            'invalid-argument',
            `${method}: un argumento no puede cruzar a Hebra (${serializeFrameError(error).message}).`
          )
        );
      }
    });
  }

  /**
   * Guarda `fn` para que Hebra la llame por su número. Con `data`, lo que `fn` devuelve vuelve
   * a Hebra tal cual (clonado estructurado); sin él, solo valores simples.
   */
  callback(fn: AnyFunction, options?: { readonly data?: boolean }): PluginCallbackRef {
    const callback = this.#nextCallback++;
    this.#callbacks.set(callback, fn);
    if (options?.data === true) this.#dataCallbacks.add(callback);
    return { callback };
  }

  /** Olvida una función guardada (su registro se dio de baja). */
  release(ref: PluginCallbackRef | undefined): void {
    if (!ref) return;
    this.#callbacks.delete(ref.callback);
    this.#dataCallbacks.delete(ref.callback);
  }

  /** Escucha un tema de `event`. Devuelve cómo dejar de escuchar. */
  on(topic: string, listener: (payload: unknown) => void): () => void {
    let set = this.#topics.get(topic);
    if (!set) this.#topics.set(topic, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Un fallo del plugin (un listener que lanza, un registro que Hebra rechazó). */
  fault(where: string, error: unknown): void {
    void this.call('runtime.fault', [
      { stage: 'runtime', where, ...serializeFrameError(error) }
    ]).catch(() => {});
  }

  /** Cierra el puerto: lo pendiente rechaza con `plugin-disposed` y nada más se llama. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      entry.reject(frameApiError('plugin-disposed', 'El plugin se ha apagado.'));
    }
    this.#pending.clear();
    this.#callbacks.clear();
    this.#dataCallbacks.clear();
    this.#topics.clear();
    this.#port.close();
  }

  #post(message: PluginFrameToHost): void {
    if (this.#closed) return;
    try {
      this.#port.postMessage(message);
    } catch {
      // El valor no se puede clonar: Hebra recibe `null` en su lugar (abajo solo se mandan
      // valores simples, así que no debería pasar).
      if (message.type === 'callback-result') this.#port.postMessage({ ...message, value: null });
    }
  }

  #runCallback(callback: number, args: readonly unknown[], id: number | undefined): void {
    const fn = this.#callbacks.get(callback);
    const answer = id !== undefined;
    if (!fn) {
      if (answer) {
        this.#post({
          type: 'callback-error',
          id,
          error: {
            name: 'PluginApiError',
            code: 'plugin-disposed',
            message: 'Ya no está registrada.'
          }
        });
      }
      return;
    }
    let result: unknown;
    try {
      result = (fn as (...values: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
    } catch (error) {
      if (answer) this.#post({ type: 'callback-error', id, error: serializeFrameError(error) });
      else this.fault('callback', error);
      return;
    }
    if (!answer) {
      if (isThenable(result))
        Promise.resolve(result).catch((error) => this.fault('callback', error));
      return;
    }
    const structured = this.#dataCallbacks.has(callback);
    Promise.resolve(result).then(
      (value) =>
        this.#post({
          type: 'callback-result',
          id,
          value: structured ? (value === undefined ? null : value) : simpleValue(value)
        }),
      (error) => this.#post({ type: 'callback-error', id, error: serializeFrameError(error) })
    );
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Solo valores simples vuelven a Hebra desde un callback (una guardia da `boolean`), salvo los
 * `provide` del editor declarativo (`callback(fn, { data: true })`): su respuesta es una lista
 * de rangos o un resultado de sugerencias, y Hebra la valida entera (`./editor.ts`).
 */
function simpleValue(value: unknown): string | number | boolean | null {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
    ? value
    : null;
}

// ---- La API ----

/** Lo que el arranque da a L14 para enchufar su almacenamiento (`PluginFrameExtensions`). */
export interface PluginFrameExtensionContext {
  readonly snapshot: PluginBootSnapshot;
  /** Un método de su espacio (`storage.device.set`…), por el mismo puerto. */
  call(
    method: `${string}.${string}`,
    args: readonly unknown[],
    transfer?: Transferable[]
  ): Promise<unknown>;
  /** Un tema de `event` de su espacio. */
  on(topic: string, listener: (payload: unknown) => void): () => void;
  /** Un fallo atribuido al plugin. */
  fault(where: string, error: unknown): void;
}

/**
 * PUNTO DE REGISTRO de L14 en el marco (spec §5.5.4): quien sirve el almacenamiento del
 * plugin pone aquí sus proveedores y `createFrameApi` los usa. Sin ellos, `storage.device` y
 * `storage.indexedDB` responden `capability-not-available`.
 */
export interface PluginFrameExtensions {
  /** El espejo síncrono de `storage.device` (con `flush`), sobre `snapshot.device`. */
  readonly device?: (context: PluginFrameExtensionContext) => PluginDeviceStorage;
  /** La fábrica IndexedDB del plugin y su `IDBKeyRange`. */
  readonly indexedDB?: (context: PluginFrameExtensionContext) => {
    readonly indexedDB: IDBFactory;
    readonly IDBKeyRange: typeof IDBKeyRange;
  };
}

/**
 * Lo que el marco de ejecución necesita para llegar a las superficies (L5): sus elementos, el
 * glifo de un icono, medidas y el portapapeles de respaldo. El arranque de Hebra lo da con
 * `frame-surfaces.ts`; sin él (el host falso), todo lo que necesita superficie responde
 * `capability-not-available`.
 */
export interface PluginFrameSurfaceAccess {
  /** El elemento raíz de la superficie del `ticket` (en el documento de ESA superficie). */
  open(ticket: PluginSurfaceTicket): HTMLElement;
  /** Se acabó la superficie: suelta lo que se guardó de ella. */
  close(surfaceId: string): void;
  /** El id de la superficie en la que está `el`, o `null` si no está en ninguna. */
  surfaceOf(el: unknown): string | null;
  /** `ui.setIcon`: pinta el glifo en el documento de `el`. */
  setIcon(el: HTMLElement, name: string): void;
  /** El rectángulo de `el` en coordenadas de su superficie. */
  bounds(el: HTMLElement): PluginSurfaceRect;
  /** Respaldo de `clipboard.writeText` si Hebra no tiene la activación (spec §5.5.6). */
  writeClipboard?(text: string): Promise<void>;
}

export interface CreateFrameApiOptions {
  readonly client: PluginFrameClient;
  readonly snapshot: PluginBootSnapshot;
  /** Las funciones puras de `markdown` (en Hebra, las de su lector; en el host falso, las suyas). */
  readonly markdown: PluginMarkdown;
  /** `storage.indexedDbName` (el mismo nombre que en la 1.x, spec §5.5.4). */
  readonly indexedDbName: (name: string) => string;
  readonly extensions?: PluginFrameExtensions;
  /** Superficies (L5). */
  readonly surfaces?: PluginFrameSurfaceAccess;
}

/** Para `ui.notice` y `ui.openMenu`: callbacks que no tienen asa y se sueltan al reemplazarse. */
const MAX_NOTICE_CALLBACKS = 32;

/**
 * La API 2.0 de un plugin dentro de su marco. Congelada: el plugin no la reescribe.
 */
export function createFrameApi(options: CreateFrameApiOptions): HebraPluginApi {
  const { client } = options;
  const snapshot = options.snapshot;
  const has = snapshot.has as Readonly<Record<string, boolean | undefined>>;
  const capabilityErrors = (snapshot.capabilityErrors ?? {}) as Readonly<
    Record<string, PluginApiErrorShape | undefined>
  >;

  // ---- estado de la instantánea (los eventos lo cambian ANTES de avisar) ----
  let online = snapshot.env.online;
  let isoDates = snapshot.env.isoDates;
  let activeNote: PluginActiveNote | null = snapshot.activeNote;
  let notifyPermission: PluginNotifyPermission = snapshot.notifyPermission;

  /** Lanza el error de una capacidad que no está (lo síncrono no espera al puerto). */
  const requireSync = (capability: PluginCapability): void => {
    const error = capabilityErrors[capability];
    if (error) throw frameError(error);
  };

  /** Avisa a cada listener; uno que lanza no corta a los demás y se anota como fallo. */
  const notify = <T>(listeners: Set<(value: T) => void>, value: T, where: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        client.fault(where, error);
      }
    }
  };

  const listenOn = <T>(
    listeners: Set<(value: T) => void>,
    listener: (value: T) => void,
    onFirst?: () => void,
    onLast?: () => void
  ): PluginUnregister => {
    if (typeof listener !== 'function') {
      throw frameApiError('invalid-argument', 'El listener tiene que ser una función.');
    }
    const wrapped = (value: T): void => listener(value);
    if (listeners.size === 0) onFirst?.();
    listeners.add(wrapped);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(wrapped);
      if (listeners.size === 0) onLast?.();
    };
  };

  // Temas que llegan siempre: la instantánea.
  const onlineListeners = new Set<(online: boolean) => void>();
  const visibleListeners = new Set<(visible: boolean) => void>();
  const isoListeners = new Set<(on: boolean) => void>();
  const activeNoteListeners = new Set<(note: PluginActiveNote | null) => void>();
  const topic = <T extends PluginFrameTopic>(
    name: T,
    handler: (payload: PluginFrameTopics[T]) => void
  ): void => {
    client.on(name, (payload) => handler(payload as PluginFrameTopics[T]));
  };
  topic('env.online', (value) => {
    online = value === true;
    notify(onlineListeners, online, 'env.onOnlineChange');
  });
  topic('env.visible', (value) =>
    notify(visibleListeners, value === true, 'env.onVisibilityChange')
  );
  topic('env.isoDates', (value) => {
    isoDates = value === true;
    notify(isoListeners, isoDates, 'env.onIsoDatesChange');
  });
  topic('workspace.activeNote', (event: PluginFrameActiveNoteEvent) => {
    activeNote = event.snapshot;
    if ('changed' in event) {
      notify(activeNoteListeners, event.changed, 'workspace.onActiveNoteChange');
    }
  });
  topic('notify.permission', (value) => {
    notifyPermission = value;
  });

  // Temas que se piden: el primero que escucha suscribe, el último que se va lo suelta.
  const subscribed = new Map<PluginFrameSubscribableTopic, Set<(value: never) => void>>();
  for (const name of PLUGIN_FRAME_SUBSCRIBABLE_TOPICS) subscribed.set(name, new Set());
  const subscribable = <T extends PluginFrameSubscribableTopic>(
    name: T,
    where: string,
    listener: (value: PluginFrameTopics[T]) => void
  ): PluginUnregister => {
    const listeners = subscribed.get(name) as Set<(value: PluginFrameTopics[T]) => void>;
    return listenOn(
      listeners,
      listener,
      () => {
        void client.rpc('events.subscribe', [name]).catch((error) => client.fault(where, error));
      },
      () => {
        void client.rpc('events.unsubscribe', [name]).catch(() => {});
      }
    );
  };
  for (const name of PLUGIN_FRAME_SUBSCRIBABLE_TOPICS) {
    client.on(name, (payload) => {
      if (name === 'workspace.noteTitleRenamed') {
        const wire = payload as PluginFrameTitleRenamed;
        const event: PluginNoteTitleRenamedEvent = {
          noteId: wire.noteId,
          folderId: wire.folderId,
          oldTitle: wire.oldTitle,
          newTitle: wire.newTitle,
          undo: () => {
            void client
              .rpc('workspace.undoTitleRename', [wire.undo])
              .catch((error) => client.fault('workspace.onNoteTitleRenamed', error));
          }
        };
        notify(subscribed.get(name) as Set<(value: unknown) => void>, event, name);
        return;
      }
      notify(subscribed.get(name) as Set<(value: unknown) => void>, payload, name);
    });
  }

  // ---- registros con asa ----
  let nextHandle = 1;
  const handleRefs = new Map<number, PluginCallbackRef[]>();
  const dropHandle = (handle: number): void => {
    for (const ref of handleRefs.get(handle) ?? []) client.release(ref);
    handleRefs.delete(handle);
  };
  /** Registra en Hebra; si Hebra lo rechaza (un id que ya usa otro plugin), es un fallo. */
  const register = <M extends PluginFrameMethod>(
    method: M,
    build: (handle: number) => { args: PluginFrameRpc[M]['args']; refs: PluginCallbackRef[] },
    onRejected?: () => void
  ): number => {
    const handle = nextHandle++;
    const { args, refs } = build(handle);
    handleRefs.set(handle, refs);
    client.rpc(method, args).catch((error) => {
      dropHandle(handle);
      onRejected?.();
      client.fault(method, error);
    });
    return handle;
  };
  const releaser = (handle: number, after?: () => void): PluginUnregister => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      dropHandle(handle);
      after?.();
      void client.rpc('handle.release', [handle]).catch(() => {});
    };
  };
  const fn = <F>(value: F, what: string): F => {
    if (typeof value !== 'function') {
      throw frameApiError('invalid-argument', `${what} tiene que ser una función.`);
    }
    return value;
  };
  const text = (value: unknown, what: string): string => {
    if (typeof value !== 'string')
      throw frameApiError('invalid-argument', `${what} tiene que ser texto.`);
    return value;
  };

  // Ids propios ya registrados: la 1.x lanza en síncrono si se repiten (`host-ui.ts`).
  const commandIds = new Set<string>();
  const statusBarIds = new Set<string>();
  const decorationIds = new Set<string>();
  const completionIds = new Set<string>();

  const pointerOf = (value: unknown): PluginPointerInfo | undefined =>
    typeof value === 'object' && value !== null ? (value as PluginPointerInfo) : undefined;

  const ribbonArgs = (handle: number, item: PluginRibbonDefinition) => {
    const onClick = client.callback((pointer?: unknown) => item.onClick(pointerOf(pointer)));
    const { onClick: _onClick, ...rest } = item;
    return { args: [handle, { ...rest, onClick }] as const, refs: [onClick] };
  };

  // ---- superficies (L5) ----
  interface SurfaceEntry {
    unmount?(): void;
    visible?(visible: boolean): void;
  }
  const surfacesOrThrow = (what: string): PluginFrameSurfaceAccess => {
    if (!options.surfaces) throw notYet(what);
    return options.surfaces;
  };
  const cleanupEntry = (result: unknown): SurfaceEntry =>
    typeof result === 'function' ? { unmount: result as () => void } : {};
  const sectionEntry = (result: unknown): SurfaceEntry => {
    if (typeof result === 'function') return { unmount: result as () => void };
    if (typeof result === 'object' && result !== null) {
      const part = result as PluginViewSectionMount;
      return {
        ...(typeof part.unmount === 'function' ? { unmount: () => part.unmount!() } : {}),
        ...(typeof part.onVisibilityChange === 'function'
          ? { visible: (v: boolean) => part.onVisibilityChange!(v) }
          : {})
      };
    }
    return {};
  };
  /** La función única que Hebra llama para montar, avisar de visibilidad y desmontar. */
  const surfaceCallback = (
    mountFn: (el: HTMLElement, call: Extract<PluginSurfaceCall, { op: 'mount' }>) => SurfaceEntry
  ): PluginCallbackRef => {
    const live = new Map<string, SurfaceEntry>();
    return client.callback((call: PluginSurfaceCall) => {
      const access = options.surfaces!;
      if (call.op === 'mount') {
        const el = access.open(call.ticket);
        live.set(call.ticket.surfaceId, mountFn(el, call));
        return null;
      }
      if (call.op === 'visible') {
        live.get(call.surfaceId)?.visible?.(call.visible === true);
        return null;
      }
      const entry = live.get(call.surfaceId);
      live.delete(call.surfaceId);
      try {
        entry?.unmount?.();
      } finally {
        access.close(call.surfaceId);
      }
      return null;
    });
  };
  const tooltipOff = new WeakMap<object, () => void>();

  let menuRefs: PluginCallbackRef[] = [];
  const noticeRefs: PluginCallbackRef[] = [];

  const ui: PluginUi = {
    registerView(view) {
      surfacesOrThrow('ui.registerView');
      if (typeof view !== 'object' || view === null) {
        throw frameApiError('invalid-argument', 'La vista no es un objeto.');
      }
      const id = text(view.id, 'El id de la vista');
      text(view.title, 'El título de la vista');
      text(view.icon, 'El icono de la vista');
      const placement = (view as { placement?: string }).placement;
      if (placement === 'tab') throw notYet('ui.registerView (vistas de pestaña)');
      let wire: {
        id: string;
        title: string;
        icon: string;
        placement?: 'column' | 'dialog' | 'main';
        sections?: PluginMainViewDefinition['sections'];
        retainSections?: boolean;
      };
      let mounted: (
        el: HTMLElement,
        call: Extract<PluginSurfaceCall, { op: 'mount' }>
      ) => SurfaceEntry;
      if (placement === 'main') {
        const main = view as PluginMainViewDefinition;
        fn(main.mountSection, '`mountSection`');
        wire = {
          id,
          title: main.title,
          icon: main.icon,
          placement: 'main',
          sections: main.sections,
          ...(main.retainSections === undefined ? {} : { retainSections: main.retainSections })
        };
        mounted = (el, call) => sectionEntry(main.mountSection(el, String(call.section ?? '')));
      } else {
        const panel = view as PluginViewDefinition;
        fn(panel.mount, '`mount`');
        wire = {
          id,
          title: panel.title,
          icon: panel.icon,
          ...(placement === undefined ? {} : { placement: placement as 'column' | 'dialog' })
        };
        mounted = (el) => {
          panel.mount(el);
          return { unmount: () => panel.unmount?.() };
        };
      }
      const handle = register('ui.registerView', (h) => {
        const surface = surfaceCallback(mounted);
        return { args: [h, { ...wire, surface }], refs: [surface] };
      });
      return releaser(handle);
    },
    revealView(id, revealOptions) {
      void client
        .rpc('ui.revealView', [id, revealOptions])
        .catch((e) => client.fault('ui.revealView', e));
    },
    updateView(id, patch) {
      void client.rpc('ui.updateView', [id, patch]).catch((e) => client.fault('ui.updateView', e));
    },
    updateViewSection(viewId, sectionId, patch) {
      void client
        .rpc('ui.updateViewSection', [viewId, sectionId, patch])
        .catch((e) => client.fault('ui.updateViewSection', e));
    },
    registerCommand(command: PluginCommandDefinition) {
      const id = text(command?.id, 'El id del comando');
      text(command.name, 'El nombre del comando');
      fn(command.run, '`run`');
      if (commandIds.has(id)) {
        throw new Error(`Ya hay un comando de módulo registrado con el id «${id}».`);
      }
      commandIds.add(id);
      const handle = register(
        'ui.registerCommand',
        (h) => {
          const run = client.callback(() => command.run());
          return { args: [h, { id, name: command.name, run }], refs: [run] };
        },
        () => commandIds.delete(id)
      );
      return releaser(handle, () => commandIds.delete(id));
    },
    ribbon(item: PluginRibbonDefinition) {
      fn(item?.onClick, '`onClick`');
      const handle = register('ui.ribbon', (h) => ribbonArgs(h, item));
      return releaser(handle);
    },
    ribbonItem(item: PluginRibbonDefinition): PluginRibbonHandle {
      fn(item?.onClick, '`onClick`');
      const handle = register('ui.ribbonItem', (h) => ribbonArgs(h, item));
      const remove = releaser(handle);
      return {
        update(patch) {
          void client
            .rpc('handle.update', [handle, patch])
            .catch((e) => client.fault('ribbonItem.update', e));
        },
        remove
      };
    },
    settingsPanel(mount: PluginMountFn) {
      surfacesOrThrow('ui.settingsPanel');
      fn(mount, '`mount`');
      const handle = register('ui.settingsPanel', (h) => {
        const surface = surfaceCallback((el) => cleanupEntry(mount(el)));
        return { args: [h, { surface }], refs: [surface] };
      });
      return releaser(handle);
    },
    openModal(mount: PluginMountFn, modalOptions?: PluginModalOptions): PluginModalHandle {
      surfacesOrThrow('ui.openModal');
      fn(mount, '`mount`');
      const handle = nextHandle++;
      const surface = surfaceCallback((el) => cleanupEntry(mount(el)));
      const closed = modalOptions?.onClosed;
      if (closed !== undefined) fn(closed, '`onClosed`');
      const onClosed = client.callback(() => {
        dropHandle(handle);
        closed?.call(modalOptions);
      });
      handleRefs.set(handle, [surface, onClosed]);
      client
        .rpc('ui.openModal', [
          handle,
          surface,
          {
            ...(modalOptions?.title === undefined ? {} : { title: modalOptions.title }),
            onClosed
          }
        ])
        .catch((error) => {
          dropHandle(handle);
          client.fault('ui.openModal', error);
        });
      return { close: releaser(handle) };
    },
    notice(message, onClick) {
      let ref: PluginCallbackRef | undefined;
      if (onClick !== undefined) {
        ref = client.callback(() => fn(onClick, '`onClick`')());
        noticeRefs.push(ref);
        // Un aviso viejo ya no se pulsa: se suelta lo más antiguo.
        while (noticeRefs.length > MAX_NOTICE_CALLBACKS) client.release(noticeRefs.shift());
      }
      void client.rpc('ui.notice', [message, ref]).catch((e) => client.fault('ui.notice', e));
    },
    setIcon(el, name) {
      surfacesOrThrow('ui.setIcon').setIcon(el, text(name, 'El nombre del icono'));
    },
    setTooltip(el, tip) {
      const access = surfacesOrThrow('ui.setTooltip');
      text(tip, 'El texto del emergente');
      tooltipOff.get(el)?.();
      tooltipOff.delete(el);
      if (tip === '') return;
      const show = (): void => {
        const surface = access.surfaceOf(el);
        if (surface === null) return;
        void client
          .rpc('ui.tooltip', [surface, tip, access.bounds(el)])
          .catch((e) => client.fault('ui.setTooltip', e));
      };
      const hide = (): void => {
        const surface = access.surfaceOf(el);
        if (surface === null) return;
        void client.rpc('ui.tooltip', [surface, null, null]).catch(() => {});
      };
      el.addEventListener('pointerenter', show);
      el.addEventListener('pointerleave', hide);
      el.addEventListener('pointerdown', hide);
      el.addEventListener('focus', show);
      el.addEventListener('blur', hide);
      tooltipOff.set(el, () => {
        el.removeEventListener('pointerenter', show);
        el.removeEventListener('pointerleave', hide);
        el.removeEventListener('pointerdown', hide);
        el.removeEventListener('focus', show);
        el.removeEventListener('blur', hide);
      });
    },
    openMenu(items: readonly PluginMenuEntry[], position: PluginMenuPosition) {
      let surface: string | undefined;
      if (position?.element !== undefined) {
        const found = surfacesOrThrow('ui.openMenu').surfaceOf(position.element);
        if (found === null) {
          throw frameApiError(
            'invalid-argument',
            '`element` no está en una superficie de este plugin.'
          );
        }
        surface = found;
      }
      if (!Array.isArray(items))
        throw frameApiError('invalid-argument', 'Los elementos del menú van en una lista.');
      // Un menú nuevo sustituye al anterior: sus funciones ya no se pulsan.
      for (const ref of menuRefs) client.release(ref);
      menuRefs = [];
      const wire = items.map((entry) => {
        if ('separator' in entry && entry.separator === true) return { separator: true as const };
        const item = entry as Exclude<PluginMenuEntry, { separator: true }>;
        const onClick = client.callback(() => fn(item.onClick, '`onClick`')());
        menuRefs.push(onClick);
        return {
          label: item.label,
          onClick,
          ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
          ...(item.icon === undefined ? {} : { icon: item.icon })
        };
      });
      void client
        .rpc('ui.openMenu', [
          wire,
          { x: position?.x, y: position?.y, ...(surface === undefined ? {} : { surface }) }
        ])
        .catch((e) => client.fault('ui.openMenu', e));
    },
    openSettings() {
      void client.rpc('ui.openSettings', []).catch((e) => client.fault('ui.openSettings', e));
    },
    registerStatusBarItem(item: PluginStatusBarItemDefinition): PluginStatusBarItemHandle {
      const id = text(item?.id, 'El id de la pieza');
      text(item.text, 'El texto de la pieza');
      if (item.onClick !== undefined) fn(item.onClick, '`onClick`');
      if (statusBarIds.has(id)) {
        throw new Error(`Ya hay una pieza de la barra de estado registrada con el id «${id}».`);
      }
      statusBarIds.add(id);
      let clickRef: PluginCallbackRef | undefined;
      const handle = register(
        'ui.registerStatusBarItem',
        (h) => {
          const { onClick, ...rest } = item;
          clickRef = onClick ? client.callback(() => onClick()) : undefined;
          return { args: [h, { ...rest, onClick: clickRef }], refs: clickRef ? [clickRef] : [] };
        },
        () => statusBarIds.delete(id)
      );
      const remove = releaser(handle, () => statusBarIds.delete(id));
      return {
        update(patch) {
          const { onClick, ...rest } = patch ?? {};
          let wirePatch: Record<string, unknown> = rest;
          if (onClick !== undefined) {
            const next = client.callback(() => fn(onClick, '`onClick`')());
            client.release(clickRef);
            clickRef = next;
            handleRefs.set(handle, [next]);
            wirePatch = { ...rest, onClick: next };
          }
          void client
            .rpc('handle.update', [handle, wirePatch])
            .catch((e) => client.fault('registerStatusBarItem.update', e));
        },
        remove
      };
    },
    onReady(callback) {
      fn(callback, 'El callback');
      const handle = register('ui.onReady', (h) => {
        const ref = client.callback(() => callback());
        return { args: [h, ref], refs: [ref] };
      });
      return releaser(handle);
    },
    openExternal(url) {
      return client.rpc('ui.openExternal', [text(url, 'La URL')]);
    },
    pickFolder() {
      return client.rpc('ui.pickFolder', []);
    },
    keepScreenOn(viewId, on) {
      // Declaración, plataforma y propiedad de la vista las juzga Hebra (mismos errores que la 1.8).
      // Devuelve una promesa rechazada (no lanza en síncrono), como la 1.8.
      try {
        return client.rpc('ui.keepScreenOn', [text(viewId, 'El id de la vista'), on === true]);
      } catch (error) {
        return Promise.reject(error);
      }
    }
  };

  /** El id de un proveedor del editor: texto no vacío, acotado y único entre los de su clase. */
  const providerId = (value: unknown, taken: Set<string>, what: string): string => {
    const id = text(value, `El id del proveedor de ${what}`);
    if (id === '' || id.length > PLUGIN_EDITOR_LIMITS.maxIdChars) {
      throw frameApiError(
        'invalid-argument',
        `El id del proveedor de ${what} tiene entre 1 y ${PLUGIN_EDITOR_LIMITS.maxIdChars} caracteres.`
      );
    }
    if (taken.has(id)) {
      throw frameApiError('invalid-argument', `Ya hay un proveedor de ${what} con el id «${id}».`);
    }
    return id;
  };

  const editor: PluginEditor = {
    registerDecorations(provider: PluginDecorationProvider) {
      requireSync('editor');
      const id = providerId(provider?.id, decorationIds, 'decoraciones');
      fn(provider.provide, '`provide`');
      if (provider.onClick !== undefined) fn(provider.onClick, '`onClick`');
      decorationIds.add(id);
      const handle = register(
        'editor.registerDecorations',
        (h) => {
          const provide = client.callback(
            (request?: unknown) => provider.provide(request as never),
            {
              data: true
            }
          );
          const onClick = provider.onClick
            ? client.callback((click?: unknown) => provider.onClick?.(click as never))
            : undefined;
          return {
            args: [h, { id, provide, ...(onClick ? { onClick } : {}) }],
            refs: onClick ? [provide, onClick] : [provide]
          };
        },
        () => decorationIds.delete(id)
      );
      return releaser(handle, () => decorationIds.delete(id));
    },
    registerCompletion(provider: PluginCompletionProvider) {
      requireSync('editor');
      const id = providerId(provider?.id, completionIds, 'sugerencias');
      fn(provider.provide, '`provide`');
      if (provider.triggers !== undefined && !Array.isArray(provider.triggers)) {
        throw frameApiError(
          'invalid-argument',
          '`triggers` tiene que ser una lista de caracteres.'
        );
      }
      completionIds.add(id);
      const handle = register(
        'editor.registerCompletion',
        (h) => {
          const provide = client.callback(
            (request?: unknown) => provider.provide(request as never),
            {
              data: true
            }
          );
          return {
            args: [
              h,
              { id, provide, ...(provider.triggers ? { triggers: [...provider.triggers] } : {}) }
            ],
            refs: [provide]
          };
        },
        () => completionIds.delete(id)
      );
      return releaser(handle, () => completionIds.delete(id));
    },
    registerCodeBlock(language: string, render: PluginCodeBlockRenderer) {
      requireSync('editor');
      surfacesOrThrow('editor.registerCodeBlock');
      text(language, 'El lenguaje del bloque');
      fn(render, '`render`');
      const handle = register('editor.registerCodeBlock', (h) => {
        const surface = surfaceCallback((el, call) => {
          const code = call.code;
          return cleanupEntry(
            render(el, code?.source ?? '', {
              language: code?.language ?? language,
              frontmatter: code?.frontmatter ?? null
            })
          );
        });
        return { args: [h, language, surface], refs: [surface] };
      });
      return releaser(handle);
    }
  };

  const vault: PluginVault = {
    libraryId() {
      requireSync('vault.read');
      return snapshot.vault.libraryId;
    },
    rootFolderId() {
      requireSync('vault.read');
      return snapshot.vault.rootFolderId;
    },
    notesPage: (cursor, limit, scope) => client.rpc('vault.notesPage', [cursor, limit, scope]),
    noteRead: (id) => client.rpc('vault.noteRead', [id]),
    noteSummary: (ids) => client.rpc('vault.noteSummary', [ids]),
    noteCreate: (input) => client.rpc('vault.noteCreate', [input]),
    noteSave: (input) => client.rpc('vault.noteSave', [input]),
    notesRewriteBatch: (entries, batchOptions) =>
      client.rpc('vault.notesRewriteBatch', [entries, batchOptions]),
    noteMove: (id, folderId) => client.rpc('vault.noteMove', [id, folderId]),
    noteMoveIfUnchanged: (id, folderId, expected) =>
      client.rpc('vault.noteMoveIfUnchanged', [id, folderId, expected]),
    noteTrash: (id) => client.rpc('vault.noteTrash', [id]),
    noteTrashIfUnchanged: (id, expected) =>
      client.rpc('vault.noteTrashIfUnchanged', [id, expected]),
    noteRestore: (id, expected) => client.rpc('vault.noteRestore', [id, expected]),
    noteRestoreIfUnchanged: (id, expected) =>
      client.rpc('vault.noteRestoreIfUnchanged', [id, expected]),
    foldersList: () => client.rpc('vault.foldersList', []),
    folderCreate: (parentId, name) => client.rpc('vault.folderCreate', [parentId, name]),
    folderRename: (id, name) => client.rpc('vault.folderRename', [id, name]),
    folderRenameIfUnchanged: (id, name, expected) =>
      client.rpc('vault.folderRenameIfUnchanged', [id, name, expected]),
    folderMove: (id, parentId) => client.rpc('vault.folderMove', [id, parentId]),
    folderMoveIfUnchanged: (id, parentId, expected) =>
      client.rpc('vault.folderMoveIfUnchanged', [id, parentId, expected]),
    folderTrashEmpty: (id, expected) => client.rpc('vault.folderTrashEmpty', [id, expected]),
    filesPage: (folderId, subfolders, cursor, limit) =>
      client.rpc('vault.filesPage', [folderId, subfolders, cursor, limit]),
    fileRead: (ref) => client.rpc('vault.fileRead', [ref]),
    fileCreate: (folderId, name, sha256) =>
      client.rpc('vault.fileCreate', [folderId, name, sha256]),
    fileReplace: (id, sha256, expectedSha256) =>
      client.rpc('vault.fileReplace', [id, sha256, expectedSha256]),
    fileTrash: (id) => client.rpc('vault.fileTrash', [id]),
    blobRead: (sha256) => client.rpc('vault.blobRead', [sha256]),
    blobPut(bytes, putOptions) {
      // Los bytes se TRANSFIEREN (spec §5.5.3): tras la llamada, `bytes` queda vacío aquí.
      const transfer =
        bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
      return client.rpc('vault.blobPut', [bytes, putOptions], transfer);
    },
    onChange(listener: (change: PluginVaultChange) => void) {
      requireSync('vault.read');
      return subscribable('vault.change', 'vault.onChange', listener);
    }
  };

  const workspace: PluginWorkspace = {
    activeNote: () => activeNote,
    onActiveNoteChange: (listener) => listenOn(activeNoteListeners, listener),
    openNote(id, openOptions) {
      void client
        .rpc('workspace.openNote', [id, openOptions])
        .catch((e) => client.fault('workspace.openNote', e));
    },
    openView() {
      throw notYet('workspace.openView');
    },
    selectFolder(id) {
      void client
        .rpc('workspace.selectFolder', [id])
        .catch((e) => client.fault('workspace.selectFolder', e));
    },
    openSearch(query) {
      void client
        .rpc('workspace.openSearch', [query])
        .catch((e) => client.fault('workspace.openSearch', e));
    },
    onFoldersChange: (listener: (folders: readonly PluginFolder[]) => void) =>
      subscribable('workspace.folders', 'workspace.onFoldersChange', listener),
    onNotesChange: (listener: (change: PluginNotesChange) => void) =>
      subscribable('workspace.notes', 'workspace.onNotesChange', listener),
    onBeforeFolderRename(guard: PluginFolderRenameGuard) {
      fn(guard, 'La guardia');
      const handle = register('workspace.onBeforeFolderRename', (h) => {
        const ref = client.callback((event: PluginFolderRenameEvent) => guard(event));
        return { args: [h, ref], refs: [ref] };
      });
      return releaser(handle);
    },
    onNoteTitleRenamed: (listener: (event: PluginNoteTitleRenamedEvent) => void) =>
      subscribable(
        'workspace.noteTitleRenamed',
        'workspace.onNoteTitleRenamed',
        listener as unknown as (value: PluginFrameTitleRenamed) => void
      ),
    restart: () => client.rpc('workspace.restart', [])
  };

  const env: PluginEnv = {
    platform: snapshot.env.platform,
    isDesktopApp: snapshot.env.isDesktopApp,
    hostVersion: snapshot.env.hostVersion,
    locale: () => snapshot.env.locale,
    get online() {
      return online;
    },
    onOnlineChange: (listener) => listenOn(onlineListeners, listener),
    onVisibilityChange: (listener) => listenOn(visibleListeners, listener),
    appleMobile: () => snapshot.env.appleMobile,
    isoDates: () => isoDates,
    onIsoDatesChange: (listener) => listenOn(isoListeners, listener)
  };

  // ---- storage ----
  const extensionContext: PluginFrameExtensionContext = {
    snapshot,
    call: (method, args, transfer) => client.call(method, args, transfer),
    on: (name, listener) => client.on(name, listener),
    fault: (where, error) => client.fault(where, error)
  };
  const settings: PluginSettingsStorage = {
    load: <T>() => client.rpc('storage.settings.load', []) as Promise<T | null>,
    save: async (value) => {
      await client.rpc('storage.settings.save', [value]);
    },
    onChange: (listener) => subscribable('storage.settings', 'storage.settings.onChange', listener)
  };
  const missingDevice: PluginDeviceStorage = {
    get() {
      throw notYet('storage.device');
    },
    set() {
      throw notYet('storage.device');
    },
    remove() {
      throw notYet('storage.device');
    },
    flush: () => Promise.reject(notYet('storage.device'))
  };
  const device = options.extensions?.device?.(extensionContext) ?? missingDevice;
  let idb: { readonly indexedDB: IDBFactory; readonly IDBKeyRange: typeof IDBKeyRange } | null =
    null;
  const indexedDbProvider = options.extensions?.indexedDB;
  const loadIdb = () => {
    if (!indexedDbProvider) throw notYet('storage.indexedDB');
    idb ??= indexedDbProvider(extensionContext);
    return idb;
  };
  const storage: PluginStorage = {
    settings: Object.freeze(settings),
    device,
    get indexedDB() {
      return loadIdb().indexedDB;
    },
    get IDBKeyRange() {
      return loadIdb().IDBKeyRange;
    },
    indexedDbName: (name) => options.indexedDbName(name)
  };

  // ---- red, nativo ----
  const http: PluginHttp = {
    request: (request) => client.rpc('http.request', [request]),
    requestUserHost: (url, hostOptions) => client.rpc('http.requestUserHost', [url, hostOptions])
  };
  const secrets: PluginSecrets = {
    // Sin id: lo pone Hebra según el puerto (M1). Aquí no hay forma de pedir el de otro.
    get: (key) => client.rpc('secrets.get', [key]),
    set: async (key, value) => {
      await client.rpc('secrets.set', [key, value]);
    },
    clear: async (key) => {
      await client.rpc('secrets.clear', [key]);
    }
  };
  let tcpRef: PluginCallbackRef | undefined;
  const tcp: PluginTcp = {
    async listen(port, onEvent: (event: PluginTcpEvent) => void) {
      fn(onEvent, '`onEvent`');
      const ref = client.callback((event: PluginTcpEvent) => onEvent(event));
      try {
        const bound = await client.rpc('tcp.listen', [port, ref]);
        client.release(tcpRef);
        tcpRef = ref;
        return bound;
      } catch (error) {
        client.release(ref);
        throw error;
      }
    },
    write: async (id, data) => {
      await client.rpc('tcp.write', [id, data]);
    },
    end: async (id, data) => {
      await client.rpc('tcp.end', [id, data]);
    },
    destroy: async (id) => {
      await client.rpc('tcp.destroy', [id]);
    },
    async close() {
      await client.rpc('tcp.close', []);
      client.release(tcpRef);
      tcpRef = undefined;
    }
  };

  const soundError = (): Error => {
    const declared = capabilityErrors['notify.sound'];
    return declared ? frameError(declared) : notYet('notify.sound');
  };
  const sound: PluginSoundPlayer = {
    async register(id, given) {
      if (capabilityErrors['notify.sound']) throw soundError();
      if (!(given?.bytes instanceof Uint8Array)) {
        throw frameApiError('invalid-argument', 'Hace falta `bytes` (un Uint8Array).');
      }
      const transfer = given.bytes.buffer instanceof ArrayBuffer ? [given.bytes.buffer] : [];
      await client.rpc(
        'notify.sound.register',
        [text(id, 'El id del sonido'), { bytes: given.bytes, mime: given.mime }],
        transfer
      );
    },
    play(id, playOptions) {
      if (capabilityErrors['notify.sound']) return Promise.reject(soundError());
      return client.rpc('notify.sound.play', [text(id, 'El id del sonido'), playOptions]);
    },
    async unregister(id) {
      if (capabilityErrors['notify.sound']) throw soundError();
      await client.rpc('notify.sound.unregister', [text(id, 'El id del sonido')]);
    }
  };
  const notifyApi: PluginNotify = {
    /**
     * Síncrono, como en la 1.x: responde según el permiso de la instantánea y manda el aviso;
     * lo que diga Hebra corrige el permiso para el siguiente.
     */
    system(input: PluginSystemNotifyInput): PluginSystemNotificationOutcome {
      requireSync('notify.system');
      if (
        typeof input !== 'object' ||
        input === null ||
        typeof input.title !== 'string' ||
        typeof input.body !== 'string'
      ) {
        return 'unavailable';
      }
      const predicted: PluginSystemNotificationOutcome =
        notifyPermission === 'granted'
          ? 'shown'
          : notifyPermission === 'denied'
            ? 'denied'
            : notifyPermission === 'default'
              ? 'pending'
              : 'unavailable';
      if (predicted === 'denied') return predicted;
      const sent: PluginSystemNotifyInput = {
        title: input.title,
        body: input.body,
        ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
        ...(input.silent === undefined ? {} : { silent: input.silent })
      };
      void client.rpc('notify.system', [sent]).then(
        (outcome) => {
          if (outcome === 'shown') notifyPermission = 'granted';
          else if (outcome === 'denied') notifyPermission = 'denied';
        },
        (error) => client.fault('notify.system', error)
      );
      return predicted;
    },
    sound
  };

  const background: PluginBackground = {
    hold: async () => {
      await client.rpc('background.hold', []);
    },
    release: async () => {
      await client.rpc('background.release', []);
    }
  };

  const clipboard: PluginClipboard = {
    async writeText(value) {
      const content = text(value, 'El texto');
      try {
        await client.rpc('clipboard.writeText', [content]);
      } catch (error) {
        // Sin la activación del gesto en Hebra, se intenta el portapapeles de la superficie.
        const fallback = options.surfaces?.writeClipboard;
        if (!isPluginApiError(error, 'user-activation-required') || !fallback) throw error;
        try {
          await fallback(content);
        } catch {
          throw error;
        }
      }
    }
  };

  const markdown: PluginMarkdown = {
    setProperty: (body, key, value) => options.markdown.setProperty(body, key, value),
    frontmatter: (body) => options.markdown.frontmatter(body),
    withTitle: (body, title) => options.markdown.withTitle(body, title),
    frontmatterRange: (body) => options.markdown.frontmatterRange(body)
  };

  return Object.freeze({
    apiVersion: snapshot.apiVersion,
    plugin: Object.freeze({ id: snapshot.plugin.id, version: snapshot.plugin.version }),
    has: (capability: PluginCapability | PluginHostFeature) => has[capability] === true,
    isError: isPluginApiError,
    env: Object.freeze(env),
    ui: Object.freeze(ui),
    editor: Object.freeze(editor),
    vault: Object.freeze(vault),
    workspace: Object.freeze(workspace),
    markdown: Object.freeze(markdown),
    storage: Object.freeze(storage),
    http: Object.freeze(http),
    secrets: Object.freeze(secrets),
    tcp: Object.freeze(tcp),
    notify: Object.freeze(notifyApi),
    clipboard: Object.freeze(clipboard),
    background: Object.freeze(background)
  });
}

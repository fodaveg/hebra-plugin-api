/**
 * Host FALSO de la API 2.0 (lote L4 del plan C1; spec §5.5): un `HebraPluginApi` de la 2.0
 * para probar un plugin sin Hebra y sin marco, `hebra-plugin-api/v2/testing`.
 *
 * No es un doble escrito aparte: es la MISMA API que recibe el plugin en su marco
 * (`./frame-api.ts`, la que monta el arranque de Hebra), hablando por un puerto en memoria con
 * el MISMO servidor del lado de Hebra (`./host-dispatch.ts`), que aquí sirve las llamadas con
 * el host falso de la 1.x (`../testing.ts`: biblioteca en memoria con revisiones y conflictos,
 * capacidades, hosts del usuario…). Así un test ve lo que verá el plugin en Hebra:
 *
 * - Lo síncrono sale de la instantánea; lo asíncrono cruza el puerto (clonado estructurado: lo
 *   que no se puede clonar falla como en el marco, y `vault.blobPut` deja vacíos los bytes).
 * - Los errores llegan serializados: se reconocen con `api.isError(error, code)`.
 * - Las funciones que el plugin registra se quedan de su lado y Hebra las llama por número:
 *   `fake.runCommand(id)` o `fake.host.recorded.commands[i].run()` las ejecutan de verdad.
 * - Lo que el marco aún no da (superficies, `editor.registerCodeBlock`, portapapeles, sonido,
 *   `openExternal`, `storage.device` e IndexedDB sin L14) responde `capability-not-available`,
 *   como en Hebra. El editor declarativo (decoraciones y sugerencias) sí está: ver `editor`.
 *
 * Lo que NO imita: el handshake y el origen (no hay marco), los plazos de Hebra (una guardia
 * que no responde espera aquí lo que tarde) ni el `document` del marco (es el del test).
 */
import { createFakePluginApi, type FakePluginApi, type FakePluginApiOptions } from './_v1/testing';
import type {
  HebraPluginApi as HebraPluginApiV1,
  PluginActiveNote,
  PluginCapability as PluginCapabilityV1,
  PluginFolder,
  PluginFolderRenameEvent,
  PluginFolderRenameGuard,
  PluginNotesChange,
  PluginNoteTitleRenamedEvent,
  PluginOpenNoteOptions
} from './_v1/index';
import { createFrameApi, PluginFrameClient, type PluginFrameExtensions } from './frame-api';
import { sanitizeCompletion, sanitizeDecorations } from './editor';
import {
  createFrameDispatcher,
  createFrameHostChannel,
  frameBootSnapshot,
  type PluginFrameEditorHost
} from './host-dispatch';
import type {
  HebraPluginApi,
  PluginApiErrorShape,
  PluginCapability,
  PluginCompletionProvider,
  PluginCompletionResult,
  PluginDecoration,
  PluginDecorationProvider
} from './index';
import type {
  PluginFrameNamespaceHandlers,
  PluginFrameToHost,
  PluginHostToFrame,
  PluginNotifyPermission
} from './protocol';
import { serializeFrameError } from './wire';

export interface FakePluginApiV2Options extends Omit<FakePluginApiOptions, 'capabilities'> {
  /** Las capacidades declaradas (las de la 2.0: también `notify.sound`). */
  capabilities?: readonly PluginCapability[];
  /** `env.online` al empezar (por defecto `true`). */
  online?: boolean;
  /** Si Hebra se ve al empezar (por defecto `true`). */
  visible?: boolean;
  /** `env.locale()` (por defecto `'es-ES'`). */
  locale?: string;
  /** La nota activa al empezar (por defecto ninguna). */
  activeNote?: PluginActiveNote | null;
  /** El permiso de avisos que ve Hebra (por defecto `'granted'` si `notify.system` está). */
  notifyPermission?: PluginNotifyPermission;
  /** Proveedores de L14 en el marco (`storage.device`, `storage.indexedDB`). */
  extensions?: PluginFrameExtensions;
  /** Espacios de L14 en el lado de Hebra (los que esos proveedores llaman). */
  namespaces?: Readonly<Record<string, PluginFrameNamespaceHandlers>>;
}

export interface FakePluginApiV2 {
  /** La API 2.0 que recibe el plugin. */
  api: HebraPluginApi;
  /** El host falso de la 1.x que sirve las llamadas: su biblioteca (`touchNote`,
   *  `emitVaultChange`…), `setIsoDates` y lo registrado (`recorded`). */
  host: FakePluginApi;
  recorded: FakePluginApi['recorded'] & {
    /** Cada `workspace.openNote`, en orden. */
    openedNotes: { id: string; options?: PluginOpenNoteOptions }[];
    selectedFolders: string[];
    searches: string[];
    /** Fallos atribuidos al plugin (un listener que lanza, un registro rechazado…). */
    faults: { where: string; message: string }[];
  };
  /**
   * Hebra ejecutando el editor declarativo (L6, spec §6.1). Llama a los proveedores que el
   * plugin registró, por el puerto, y valida lo que devuelven como Hebra: un rango fuera del
   * trozo pedido, vacío o con un estilo que no es del juego fijo se descarta, y se aplican los
   * topes de cantidad y de tamaño. NO imita el tope de tiempo (300 ms y 250 ms en Hebra) ni el
   * pintado.
   */
  editor: {
    /** Los ids de los proveedores registrados ahora. */
    providers(): { decorations: string[]; completions: string[] };
    /**
     * Pide las decoraciones del trozo `text` (que empieza en `offset` de una nota de `length`
     * caracteres) a TODOS los proveedores. En una nota protegida (`protectedNote`) no llama a
     * ninguno y devuelve `[]` (spec §8.5).
     */
    decorate(input: {
      noteId?: string;
      text: string;
      offset?: number;
      length?: number;
      protectedNote?: boolean;
    }): Promise<PluginDecoration[]>;
    /** Un clic en el rango `from`-`to`: llama al `onClick` de los proveedores que lo tienen. */
    click(input: { noteId?: string; from: number; to: number; data?: string }): Promise<void>;
    /**
     * Pide sugerencias con el cursor en `pos` de la línea `line` (que empieza en `lineFrom`).
     * Devuelve las del primer proveedor que las da (o `null`). Nada en una nota protegida.
     */
    complete(input: {
      noteId?: string;
      line: string;
      lineFrom?: number;
      pos?: number;
      explicit?: boolean;
      protectedNote?: boolean;
    }): Promise<PluginCompletionResult | null>;
  };
  /** La red cambia: avisa a `env.onOnlineChange` (y `env.online` ya es el nuevo). */
  setOnline(online: boolean): void;
  /** Hebra se oculta o vuelve: avisa a `env.onVisibilityChange`. */
  setVisible(visible: boolean): void;
  /** La persona cambia de nota o de pestaña: `activeNote()` y `onActiveNoteChange`. */
  setActiveNote(note: PluginActiveNote | null): void;
  emitFolders(folders: readonly PluginFolder[]): void;
  emitNotesChange(change: PluginNotesChange): void;
  /** Hebra renombra una nota por su título: `onNoteTitleRenamed`. `undone()` dice si el
   *  plugin llamó a `undo()`. */
  renameNoteTitle(event: Omit<PluginNoteTitleRenamedEvent, 'undo'>): { undone(): boolean };
  /** La persona va a renombrar o mover una carpeta: pregunta a las guardias (`false` cancela). */
  confirmFolderRename(event: PluginFolderRenameEvent): Promise<boolean>;
  /** Ejecuta un comando registrado como lo haría Hebra (paleta, atajo) y espera a que acabe. */
  runCommand(id: string): Promise<void>;
  /** Espera a que el puerto se vacíe (llamadas, eventos y funciones en curso). */
  settle(): Promise<void>;
  /** Apaga: lo pendiente rechaza con `plugin-disposed` y se quita lo registrado. */
  dispose(): Promise<void>;
}

type Endpoint = {
  post(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((data: unknown) => void) | null;
  close(): void;
};

/** Un `MessageChannel` en memoria: clonado estructurado (con transferencia) y entrega asíncrona. */
function memoryChannel(): { a: Endpoint; b: Endpoint; inFlight(): number } {
  let inFlight = 0;
  let closed = false;
  const make = (): Endpoint => ({ post: () => {}, onmessage: null, close: () => {} });
  const a = make();
  const b = make();
  const wire = (from: Endpoint, to: Endpoint): void => {
    from.post = (message, transfer = []) => {
      if (closed) return;
      const data = structuredClone(message, { transfer });
      inFlight += 1;
      // Microtarea, no temporizador: funciona igual con los temporizadores falsos de un test.
      queueMicrotask(() => {
        inFlight -= 1;
        if (!closed) to.onmessage?.(data);
      });
    };
    from.close = () => {
      closed = true;
    };
  };
  wire(a, b);
  wire(b, a);
  return { a, b, inFlight: () => inFlight };
}

export function createFakePluginApiV2(options: FakePluginApiV2Options = {}): FakePluginApiV2 {
  const {
    capabilities = [],
    online: initialOnline = true,
    visible: initialVisible = true,
    locale = 'es-ES',
    activeNote: initialNote = null,
    notifyPermission,
    extensions,
    namespaces,
    ...rest
  } = options;
  const v1Capabilities = capabilities.filter(
    (name): name is PluginCapabilityV1 => name !== 'notify.sound'
  );
  const host = createFakePluginApi({ ...rest, capabilities: v1Capabilities });
  const base = host.api;

  // ---- lo que el host falso de la 1.x no mueve: entorno y espacio de trabajo ----
  let online = initialOnline;
  let activeNote = initialNote;
  const onlineListeners = new Set<(value: boolean) => void>();
  const visibleListeners = new Set<(value: boolean) => void>();
  const activeListeners = new Set<(note: PluginActiveNote | null) => void>();
  const folderListeners = new Set<(folders: readonly PluginFolder[]) => void>();
  const notesListeners = new Set<(change: PluginNotesChange) => void>();
  const titleListeners = new Set<(event: PluginNoteTitleRenamedEvent) => void>();
  const guards = new Set<PluginFolderRenameGuard>();
  const add =
    <T>(set: Set<T>) =>
    (value: T) => {
      set.add(value);
      return () => void set.delete(value);
    };
  const recorded: FakePluginApiV2['recorded'] = Object.assign(host.recorded, {
    openedNotes: [] as { id: string; options?: PluginOpenNoteOptions }[],
    selectedFolders: [] as string[],
    searches: [] as string[],
    faults: [] as { where: string; message: string }[]
  });
  const served: HebraPluginApiV1 = {
    ...base,
    env: {
      ...base.env,
      locale: () => locale,
      get online() {
        return online;
      },
      onOnlineChange: add(onlineListeners),
      onVisibilityChange: add(visibleListeners),
      appleMobile: base.env.appleMobile,
      isoDates: base.env.isoDates,
      onIsoDatesChange: base.env.onIsoDatesChange
    },
    workspace: {
      ...base.workspace,
      activeNote: () => activeNote,
      onActiveNoteChange: add(activeListeners),
      openNote: (id, openOptions) => {
        recorded.openedNotes.push(
          openOptions === undefined ? { id } : { id, options: openOptions }
        );
      },
      selectFolder: (id) => void recorded.selectedFolders.push(id),
      openSearch: (query) => void recorded.searches.push(query),
      onFoldersChange: add(folderListeners),
      onNotesChange: add(notesListeners),
      onBeforeFolderRename: add(guards),
      onNoteTitleRenamed: add(titleListeners)
    }
  };

  const has = (name: PluginCapability): boolean =>
    name === 'notify.sound' ? false : base.has(name as PluginCapabilityV1);
  const declared = new Set<string>(capabilities);
  const capabilityError = (name: PluginCapability): PluginApiErrorShape | null => {
    if (name === 'notify.sound') {
      return declared.has(name)
        ? {
            name: 'PluginApiError',
            code: 'capability-not-available',
            message: '«notify.sound» todavía no está disponible en esta versión de Hebra.'
          }
        : {
            name: 'PluginApiError',
            code: 'capability-not-declared',
            message: 'El plugin no declara «notify.sound» en hebra.json (capabilities).'
          };
    }
    if (has(name)) return null;
    return declared.has(name)
      ? {
          name: 'PluginApiError',
          code: 'unavailable-on-platform',
          message: `«${name}» no está disponible en esta plataforma (${base.env.platform}).`
        }
      : {
          name: 'PluginApiError',
          code: 'capability-not-declared',
          message: `El plugin no declara «${name}» en hebra.json (capabilities).`
        };
  };

  // ---- el editor declarativo (L6): Hebra llama a los proveedores del plugin ----
  const decorationProviders = new Map<string, PluginDecorationProvider>();
  const completionProviders = new Map<string, PluginCompletionProvider>();
  const editorHost: PluginFrameEditorHost = {
    capabilityError: () => capabilityError('editor'),
    registerDecorations(provider) {
      decorationProviders.set(provider.id, provider);
      return () => void decorationProviders.delete(provider.id);
    },
    registerCompletion(provider) {
      completionProviders.set(provider.id, provider);
      return () => void completionProviders.delete(provider.id);
    }
  };

  // ---- el puerto ----
  const channel = memoryChannel();
  const hebraSide = channel.a;
  const frameSide = channel.b;
  let booted = false;
  const hostChannel = createFrameHostChannel({
    post: (message: PluginHostToFrame) => hebraSide.post(message),
    canEmit: () => booted
  });
  const fault = (where: string, error: unknown): void => {
    recorded.faults.push({ where, message: serializeFrameError(error).message });
  };
  const dispatcher = createFrameDispatcher({
    api: served,
    invoke: (ref, args, expectResult, timeoutMs) =>
      hostChannel.invoke(ref, args, expectResult, timeoutMs),
    emit: (topic, payload) => hostChannel.emit(topic, payload),
    report: fault,
    editor: editorHost,
    ...(namespaces ? { namespaces } : {})
  });
  hebraSide.onmessage = (data) => {
    if (hostChannel.settle(data)) return;
    const message = data as PluginFrameToHost;
    if (message?.type !== 'call') return;
    if (message.method === 'runtime.fault') {
      const detail = (message.args[0] ?? {}) as { where?: unknown; message?: unknown };
      recorded.faults.push({
        where: String(detail.where ?? 'marco'),
        message: String(detail.message ?? '')
      });
      hostChannel.answer(message.id, () => null);
      return;
    }
    hostChannel.answer(message.id, () => dispatcher.call(message.method, message.args));
  };

  const snapshot = frameBootSnapshot({
    api: served,
    dispatcher,
    apiVersion: '2.1.0',
    plugin: base.plugin,
    capabilityError,
    visible: initialVisible,
    notifyPermission: notifyPermission ?? (has('notify.system') ? 'granted' : 'unavailable')
  });

  let api: HebraPluginApi | null = null;
  const client = new PluginFrameClient(
    {
      postMessage: (message, transfer) => frameSide.post(message, transfer),
      close: () => frameSide.close()
    },
    {
      boot: (bootSnapshot) => {
        api = createFrameApi({
          client,
          snapshot: bootSnapshot,
          markdown: base.markdown,
          indexedDbName: (name) => base.storage.indexedDbName(name),
          ...(extensions ? { extensions } : {})
        });
      },
      dispose: () => client.close()
    }
  );
  frameSide.onmessage = (data) => client.receive(data);
  // El `boot` que mandaría Hebra, ya clonado como por el puerto.
  client.receive(structuredClone({ type: 'boot', snapshot }));
  booted = true;

  const emitTo = <T>(set: Set<(value: T) => void>, value: T): void => {
    for (const listener of [...set]) listener(value);
  };

  /** Hasta que el puerto lleva varias vueltas vacío (sin temporizadores: vale con los falsos). */
  const settle = async (): Promise<void> => {
    let quiet = 0;
    for (let round = 0; round < 10_000 && quiet < 20; round += 1) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      quiet = channel.inFlight() === 0 ? quiet + 1 : 0;
    }
  };

  return {
    api: api!,
    host,
    recorded,
    setOnline(value) {
      online = value;
      emitTo(onlineListeners, value);
    },
    setVisible(value) {
      emitTo(visibleListeners, value);
    },
    setActiveNote(note) {
      activeNote = note;
      emitTo(activeListeners, note);
    },
    emitFolders: (folders) => emitTo(folderListeners, folders),
    emitNotesChange: (change) => emitTo(notesListeners, change),
    renameNoteTitle(event) {
      let undone = false;
      emitTo(titleListeners, {
        ...event,
        undo: () => {
          undone = true;
        }
      });
      return { undone: () => undone };
    },
    async confirmFolderRename(event) {
      for (const guard of [...guards]) {
        if ((await guard(event)) === false) return false;
      }
      return true;
    },
    async runCommand(id) {
      const command = host.recorded.commands.find((candidate) => candidate.id === id);
      if (!command) throw new Error(`createFakePluginApiV2: no hay ningún comando «${id}».`);
      await command.run();
    },
    settle,
    editor: {
      providers: () => ({
        decorations: [...decorationProviders.keys()],
        completions: [...completionProviders.keys()]
      }),
      async decorate(input) {
        if (input.protectedNote === true) return [];
        const offset = input.offset ?? 0;
        const request = {
          noteId: input.noteId ?? 'nota',
          offset,
          text: input.text,
          length: input.length ?? offset + input.text.length
        };
        const out: PluginDecoration[] = [];
        for (const provider of [...decorationProviders.values()]) {
          try {
            const raw = await provider.provide(request);
            out.push(...sanitizeDecorations(raw, { offset, length: input.text.length }));
          } catch (error) {
            fault(`editor.registerDecorations «${provider.id}»`, error);
          }
        }
        return out;
      },
      async click(input) {
        const click = {
          noteId: input.noteId ?? 'nota',
          from: input.from,
          to: input.to,
          data: input.data ?? null,
          pointer: { x: 0, y: 0, button: 0, alt: false, ctrl: false, meta: false, shift: false }
        };
        for (const provider of [...decorationProviders.values()]) {
          try {
            provider.onClick?.(click);
          } catch (error) {
            fault(`editor.registerDecorations «${provider.id}»`, error);
          }
        }
        await settle();
      },
      async complete(input) {
        if (input.protectedNote === true) return null;
        const lineFrom = input.lineFrom ?? 0;
        const pos = input.pos ?? lineFrom + input.line.length;
        for (const provider of [...completionProviders.values()]) {
          try {
            const raw = await provider.provide({
              noteId: input.noteId ?? 'nota',
              pos,
              line: input.line,
              lineFrom,
              explicit: input.explicit ?? true
            });
            const result = sanitizeCompletion(raw, {
              lineFrom,
              lineLength: input.line.length,
              pos
            });
            if (result) return result;
          } catch (error) {
            fault(`editor.registerCompletion «${provider.id}»`, error);
          }
        }
        return null;
      }
    },
    async dispose() {
      dispatcher.dispose();
      hostChannel.close();
      client.close();
      await settle();
    }
  };
}

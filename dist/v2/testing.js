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
import { createFakePluginApi } from './_v1/testing.js';
import { createFrameApi, PluginFrameClient } from './frame-api.js';
import { sanitizeCompletion, sanitizeDecorations } from './editor.js';
import { createFrameDispatcher, createFrameHostChannel, frameBootSnapshot } from './host-dispatch.js';
import { serializeFrameError } from './wire.js';
/** Un `MessageChannel` en memoria: clonado estructurado (con transferencia) y entrega asíncrona. */
function memoryChannel() {
    let inFlight = 0;
    let closed = false;
    const make = () => ({ post: () => { }, onmessage: null, close: () => { } });
    const a = make();
    const b = make();
    const wire = (from, to) => {
        from.post = (message, transfer = []) => {
            if (closed)
                return;
            const data = structuredClone(message, { transfer });
            inFlight += 1;
            // Microtarea, no temporizador: funciona igual con los temporizadores falsos de un test.
            queueMicrotask(() => {
                inFlight -= 1;
                if (!closed)
                    to.onmessage?.(data);
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
export function createFakePluginApiV2(options = {}) {
    const { capabilities = [], online: initialOnline = true, visible: initialVisible = true, locale = 'es-ES', activeNote: initialNote = null, notifyPermission, extensions, namespaces, ...rest } = options;
    const v1Capabilities = capabilities.filter((name) => name !== 'notify.sound');
    const host = createFakePluginApi({ ...rest, capabilities: v1Capabilities });
    const base = host.api;
    // ---- lo que el host falso de la 1.x no mueve: entorno y espacio de trabajo ----
    let online = initialOnline;
    let activeNote = initialNote;
    const onlineListeners = new Set();
    const visibleListeners = new Set();
    const activeListeners = new Set();
    const folderListeners = new Set();
    const notesListeners = new Set();
    const titleListeners = new Set();
    const guards = new Set();
    const add = (set) => (value) => {
        set.add(value);
        return () => void set.delete(value);
    };
    const recorded = Object.assign(host.recorded, {
        openedNotes: [],
        selectedFolders: [],
        searches: [],
        faults: []
    });
    const served = {
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
                recorded.openedNotes.push(openOptions === undefined ? { id } : { id, options: openOptions });
            },
            selectFolder: (id) => void recorded.selectedFolders.push(id),
            openSearch: (query) => void recorded.searches.push(query),
            onFoldersChange: add(folderListeners),
            onNotesChange: add(notesListeners),
            onBeforeFolderRename: add(guards),
            onNoteTitleRenamed: add(titleListeners)
        }
    };
    const has = (name) => name === 'notify.sound' ? false : base.has(name);
    const declared = new Set(capabilities);
    const capabilityError = (name) => {
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
        if (has(name))
            return null;
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
    const decorationProviders = new Map();
    const completionProviders = new Map();
    const editorHost = {
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
        post: (message) => hebraSide.post(message),
        canEmit: () => booted
    });
    const fault = (where, error) => {
        recorded.faults.push({ where, message: serializeFrameError(error).message });
    };
    const dispatcher = createFrameDispatcher({
        api: served,
        invoke: (ref, args, expectResult, timeoutMs) => hostChannel.invoke(ref, args, expectResult, timeoutMs),
        emit: (topic, payload) => hostChannel.emit(topic, payload),
        report: fault,
        editor: editorHost,
        ...(namespaces ? { namespaces } : {})
    });
    hebraSide.onmessage = (data) => {
        if (hostChannel.settle(data))
            return;
        const message = data;
        if (message?.type !== 'call')
            return;
        if (message.method === 'runtime.fault') {
            const detail = (message.args[0] ?? {});
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
        apiVersion: '2.0.0',
        plugin: base.plugin,
        capabilityError,
        visible: initialVisible,
        notifyPermission: notifyPermission ?? (has('notify.system') ? 'granted' : 'unavailable')
    });
    let api = null;
    const client = new PluginFrameClient({
        postMessage: (message, transfer) => frameSide.post(message, transfer),
        close: () => frameSide.close()
    }, {
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
    });
    frameSide.onmessage = (data) => client.receive(data);
    // El `boot` que mandaría Hebra, ya clonado como por el puerto.
    client.receive(structuredClone({ type: 'boot', snapshot }));
    booted = true;
    const emitTo = (set, value) => {
        for (const listener of [...set])
            listener(value);
    };
    /** Hasta que el puerto lleva varias vueltas vacío (sin temporizadores: vale con los falsos). */
    const settle = async () => {
        let quiet = 0;
        for (let round = 0; round < 10_000 && quiet < 20; round += 1) {
            await new Promise((resolve) => queueMicrotask(resolve));
            quiet = channel.inFlight() === 0 ? quiet + 1 : 0;
        }
    };
    return {
        api: api,
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
                if ((await guard(event)) === false)
                    return false;
            }
            return true;
        },
        async runCommand(id) {
            const command = host.recorded.commands.find((candidate) => candidate.id === id);
            if (!command)
                throw new Error(`createFakePluginApiV2: no hay ningún comando «${id}».`);
            await command.run();
        },
        settle,
        editor: {
            providers: () => ({
                decorations: [...decorationProviders.keys()],
                completions: [...completionProviders.keys()]
            }),
            async decorate(input) {
                if (input.protectedNote === true)
                    return [];
                const offset = input.offset ?? 0;
                const request = {
                    noteId: input.noteId ?? 'nota',
                    offset,
                    text: input.text,
                    length: input.length ?? offset + input.text.length
                };
                const out = [];
                for (const provider of [...decorationProviders.values()]) {
                    try {
                        const raw = await provider.provide(request);
                        out.push(...sanitizeDecorations(raw, { offset, length: input.text.length }));
                    }
                    catch (error) {
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
                    }
                    catch (error) {
                        fault(`editor.registerDecorations «${provider.id}»`, error);
                    }
                }
                await settle();
            },
            async complete(input) {
                if (input.protectedNote === true)
                    return null;
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
                        if (result)
                            return result;
                    }
                    catch (error) {
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

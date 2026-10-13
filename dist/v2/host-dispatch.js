/**
 * El lado de HEBRA de la API 2.0 por el puerto (lote L4 del plan C1; spec §5.5.3): recibe cada
 * `call` del marco y lo sirve con una API de la forma de la 1.x ya creada para ESE plugin.
 *
 * Es código de Hebra. Lo usan la fachada del anfitrión (`src/lib/plugins/api/frame-facade.ts`,
 * con la fachada real de la 1.x, la misma que ve un plugin 1.x: capacidades, hosts, notas
 * protegidas, nota fijada de T10…) y el host falso (`./testing.ts`, con el falso de la 1.x).
 * Así las barreras de la 2.0 son exactamente las de la 1.x, y lo único nuevo es el transporte.
 *
 * Lo que NO hace: decidir el id del plugin. La API que recibe ya está atada a un id que puso
 * quien la creó (el anfitrión, por el registro instalado y el puerto); ningún argumento de
 * ningún mensaje se usa como id. Con eso, `secrets.get` de OTRO plugin no existe (M1).
 *
 * Lo que llega por el puerto no es de fiar (el plugin puede escribir en el puerto lo que
 * quiera): asas, referencias a funciones y temas se comprueban aquí; el resto de argumentos los
 * comprueba la fachada de la 1.x como siempre (ya los comprobaba frente al propio plugin).
 */
import { PLUGIN_CAPABILITIES, PLUGIN_HOST_FEATURES } from './_v1/index.js';
import { PLUGIN_EDITOR_LIMITS, sanitizeTriggers } from './editor.js';
import { PLUGIN_FRAME_NOT_YET_SERVED, PLUGIN_FRAME_SUBSCRIBABLE_TOPICS } from './protocol.js';
import { frameApiError, frameError, serializeFrameError } from './wire.js';
export function createFrameHostChannel(options) {
    let nextId = 1;
    let closed = false;
    const pending = new Map();
    const post = (message) => {
        if (closed)
            return;
        try {
            options.post(message);
        }
        catch (error) {
            if (options.onPostError)
                options.onPostError(error);
            else
                throw error;
        }
    };
    /** Como `post`, pero deja subir el fallo (lo usa `invoke` para rechazar su llamada). */
    const postStrict = (message) => {
        if (!closed)
            options.post(message);
    };
    return {
        pendingCount: () => pending.size,
        invoke(ref, args, expectResult, timeoutMs) {
            if (closed) {
                return Promise.reject(frameApiError('plugin-disposed', 'El plugin está apagado.'));
            }
            if (!expectResult) {
                try {
                    postStrict({ type: 'callback', callback: ref.callback, args });
                }
                catch (error) {
                    return Promise.reject(error);
                }
                return Promise.resolve(null);
            }
            return new Promise((resolve, reject) => {
                const id = nextId++;
                let timer;
                const clear = () => clearTimeout(timer);
                pending.set(id, {
                    resolve: (value) => {
                        clear();
                        resolve(value);
                    },
                    reject: (error) => {
                        clear();
                        reject(error);
                    }
                });
                if (timeoutMs !== undefined) {
                    timer = setTimeout(() => {
                        if (!pending.delete(id))
                            return;
                        reject(Object.assign(new Error('El plugin no respondió a tiempo.'), {
                            name: 'PluginCallbackTimeout'
                        }));
                    }, timeoutMs);
                }
                try {
                    postStrict({ type: 'callback', callback: ref.callback, args, id });
                }
                catch (error) {
                    // Sin esto la entrada quedaba viva y la promesa, sin resolver jamás.
                    clear();
                    pending.delete(id);
                    reject(error);
                }
            });
        },
        emit(topic, payload) {
            if (options.canEmit && !options.canEmit())
                return;
            post({ type: 'event', topic, payload });
        },
        emitRaw(topic, payload) {
            if (options.canEmit && !options.canEmit())
                return;
            post({ type: 'event', topic, payload });
        },
        answer(id, work) {
            let result;
            try {
                result = Promise.resolve(work());
            }
            catch (error) {
                result = Promise.reject(error);
            }
            result.then((value) => post({ type: 'result', id, value: value === undefined ? null : value }), (error) => post({ type: 'error', id, error: serializeFrameError(error) }));
        },
        settle(data) {
            if (typeof data !== 'object' || data === null)
                return false;
            const message = data;
            if (message.type !== 'callback-result' && message.type !== 'callback-error')
                return false;
            const entry = typeof message.id === 'number' ? pending.get(message.id) : undefined;
            if (!entry)
                return true;
            pending.delete(message.id);
            if (message.type === 'callback-result')
                entry.resolve(message.value);
            else
                entry.reject(frameError(message.error));
            return true;
        },
        close() {
            if (closed)
                return;
            closed = true;
            for (const entry of pending.values()) {
                entry.reject(frameApiError('plugin-disposed', 'El plugin se ha apagado.'));
            }
            pending.clear();
        }
    };
}
function isDisposedError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.code === 'plugin-disposed');
}
/** Un error de la API (lo serializa quien responde). */
const apiError = (code, message) => frameApiError(code, message);
/**
 * La instantánea de `boot` (spec §5.5.5) a partir de la API de la forma de la 1.x: `has` y
 * `env` como los vería un plugin 1.x (menos lo que el marco aún no sirve,
 * `PLUGIN_FRAME_NOT_YET_SERVED`), `vault` solo con `vault.read` y la nota activa del
 * dispatcher (con la fijada de T10).
 */
export function frameBootSnapshot(input) {
    const { api } = input;
    const notYet = new Set(PLUGIN_FRAME_NOT_YET_SERVED);
    if (input.visual !== true) {
        notYet.add('ui.view.main');
        notYet.add('notify.sound');
    }
    const has = {};
    for (const name of [...PLUGIN_CAPABILITIES, ...PLUGIN_HOST_FEATURES]) {
        has[name] = !notYet.has(name) && api.has(name);
    }
    has['notify.sound'] =
        !notYet.has('notify.sound') && input.capabilityError('notify.sound') === null;
    const capabilityErrors = {};
    for (const name of [...PLUGIN_CAPABILITIES, 'notify.sound']) {
        const error = input.capabilityError(name);
        if (error)
            capabilityErrors[name] = error;
    }
    const readable = has['vault.read'] === true;
    return {
        apiVersion: input.apiVersion,
        plugin: { id: input.plugin.id, version: input.plugin.version },
        has,
        env: {
            platform: api.env.platform,
            isDesktopApp: api.env.isDesktopApp,
            hostVersion: api.env.hostVersion,
            locale: api.env.locale(),
            online: api.env.online,
            visible: input.visible,
            appleMobile: api.env.appleMobile(),
            isoDates: api.env.isoDates()
        },
        vault: readable
            ? { libraryId: api.vault.libraryId(), rootFolderId: api.vault.rootFolderId() }
            : { libraryId: '', rootFolderId: '' },
        activeNote: input.dispatcher.activeNote(),
        device: input.device ?? {},
        notifyPermission: input.notifyPermission,
        capabilityErrors
    };
}
function invalid(what) {
    return apiError('invalid-argument', what);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function callbackRef(value, what) {
    if (!isRecord(value) ||
        typeof value.callback !== 'number' ||
        !Number.isSafeInteger(value.callback) ||
        value.callback < 1) {
        throw invalid(`${what}: no es una función del plugin.`);
    }
    return { callback: value.callback };
}
function optionalRef(value, what) {
    return value === undefined || value === null ? undefined : callbackRef(value, what);
}
/** El clic de Hebra (un `MouseEvent` de su documento) como datos (`PluginPointerInfo`). */
export function pointerInfo(event) {
    if (typeof event !== 'object' || event === null)
        return undefined;
    const e = event;
    const num = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return {
        x: num(e.clientX),
        y: num(e.clientY),
        button: num(e.button),
        alt: e.altKey === true,
        ctrl: e.ctrlKey === true,
        meta: e.metaKey === true,
        shift: e.shiftKey === true
    };
}
const DEFAULT_MAX_UNDOS = 50;
function noteKey(note) {
    return note ? JSON.stringify([note.id, note.folderId, note.title]) : 'null';
}
/**
 * El servidor del puerto para UN plugin. Engancha en el acto lo que mantiene la instantánea
 * (red, visibilidad, fechas ISO y nota activa): créalo ANTES de leer la instantánea.
 */
export function createFrameDispatcher(options) {
    const { api, emit, report } = options;
    let disposed = false;
    const handles = new Map();
    const subscriptions = new Map();
    const undos = new Map();
    let nextUndo = 1;
    const maxUndos = options.maxUndos ?? DEFAULT_MAX_UNDOS;
    const offs = [];
    // ---- la nota activa de la instantánea (con la fijada de T10) ----
    let lastActive = noteKey(api.workspace.activeNote());
    const activeNoteNow = () => {
        const note = api.workspace.activeNote();
        return note ? { id: note.id, folderId: note.folderId, title: note.title } : null;
    };
    /**
     * Tras una acción del plugin (un comando, un clic), Hebra suelta la nota fijada en cuanto la
     * promesa acaba; la instantánea se repasa DESPUÉS de eso (siguiente vuelta del bucle).
     */
    const recheckActive = () => {
        setTimeout(() => {
            if (disposed)
                return;
            const now = activeNoteNow();
            const key = noteKey(now);
            if (key === lastActive)
                return;
            lastActive = key;
            emit('workspace.activeNote', { snapshot: now });
        }, 0);
    };
    /**
     * Una acción del plugin que Hebra lanza (comando, clic, menú): resuelve cuando ACABA en el
     * marco, para que la fachada de la 1.x mantenga fijada la nota activa mientras tanto (T10).
     * Nunca rechaza: lo que lance el plugin se anota con su id (`report`, spec §8.6).
     */
    const act = (ref, where) => (...args) => options.invoke(ref, args, true).then(() => {
        recheckActive();
    }, (error) => {
        recheckActive();
        // El apagado rechaza lo que Hebra esperaba del marco con `plugin-disposed`: lo ha
        // causado Hebra, no es un fallo del plugin.
        if (disposed || isDisposedError(error))
            return;
        report(where, error);
    });
    const always = (off) => {
        offs.push(off);
    };
    always(api.env.onOnlineChange((online) => emit('env.online', online === true)));
    always(api.env.onVisibilityChange((visible) => emit('env.visible', visible === true)));
    always(api.env.onIsoDatesChange((on) => emit('env.isoDates', on === true)));
    always(api.workspace.onActiveNoteChange((note) => {
        const now = activeNoteNow();
        lastActive = noteKey(now);
        const changed = note ? { id: note.id, folderId: note.folderId, title: note.title } : null;
        emit('workspace.activeNote', { snapshot: now, changed });
    }));
    // ---- asas ----
    const newHandle = (value) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
            throw invalid('Asa de registro inválida.');
        }
        if (handles.has(value))
            throw invalid(`El asa ${value} ya está en uso.`);
        return value;
    };
    const keep = (handle, entry) => {
        handles.set(handle, entry);
        return null;
    };
    /** Un texto que la UI de Hebra pinta o usa de clave: si no es texto, no llega a ella. */
    const text = (value, what) => {
        if (typeof value !== 'string')
            throw invalid(`${what} tiene que ser texto.`);
        return value;
    };
    const ribbonDefinition = (raw) => {
        if (!isRecord(raw))
            throw invalid('El botón del ribbon no es un objeto.');
        text(raw.icon, 'El icono del botón');
        text(raw.title, 'El título del botón');
        const onClick = callbackRef(raw.onClick, 'onClick');
        const { onClick: _onClick, ...rest } = raw;
        return {
            ...rest,
            onClick: (event) => act(onClick, 'ribbon.onClick')(pointerInfo(event))
        };
    };
    const statusBarFields = (raw) => {
        const { onClick, ...rest } = raw;
        const ref = optionalRef(onClick, 'onClick');
        return {
            rest: rest,
            onClick: ref ? act(ref, 'registerStatusBarItem.onClick') : undefined,
            hasClick: onClick !== undefined
        };
    };
    const subscribe = (topic) => {
        switch (topic) {
            case 'workspace.folders':
                return api.workspace.onFoldersChange((folders) => emit(topic, folders));
            case 'workspace.notes':
                return api.workspace.onNotesChange((change) => emit(topic, change));
            case 'workspace.noteTitleRenamed':
                return api.workspace.onNoteTitleRenamed((event) => {
                    const undo = nextUndo++;
                    undos.set(undo, event.undo);
                    for (const old of undos.keys()) {
                        if (undos.size <= maxUndos)
                            break;
                        undos.delete(old);
                    }
                    emit(topic, {
                        noteId: event.noteId,
                        folderId: event.folderId,
                        oldTitle: event.oldTitle,
                        newTitle: event.newTitle,
                        undo
                    });
                });
            case 'vault.change':
                return api.vault.onChange((change) => emit(topic, change));
            case 'storage.settings':
                return api.storage.settings.onChange((value) => emit(topic, value));
        }
    };
    const topicOf = (value) => {
        if (!PLUGIN_FRAME_SUBSCRIBABLE_TOPICS.includes(value)) {
            throw invalid(`Tema desconocido: «${String(value).slice(0, 60)}».`);
        }
        return value;
    };
    const { ui, vault, workspace, storage, http, secrets, tcp, notify, background } = api;
    // ---- superficies (L5) ----
    const services = (what) => {
        if (!options.ui) {
            throw apiError('capability-not-available', `${what}: esta versión de Hebra todavía no lo ofrece a los plugins 2.0.`);
        }
        return options.ui;
    };
    /**
     * Monta lo del plugin en una superficie nueva dentro de `el`. El marco de la superficie se
     * crea ya; cuando está listo, el marco de ejecución monta (`surface` con `op: 'mount'`). Un
     * fallo del plugin al montar se anota con su id y la superficie queda vacía.
     */
    const surfaceInto = (el, ref, spec, extra = {}) => {
        const surface = services('superficie').createSurface(el, spec);
        let surfaceId = null;
        let gone = false;
        const call = (value, expectResult) => options.invoke(ref, [value], expectResult);
        surface.ready.then((ticket) => {
            if (gone || disposed)
                return;
            surfaceId = ticket.surfaceId;
            call({ op: 'mount', ticket, ...extra }, true).catch((error) => {
                if (!gone && !disposed)
                    report(`montar «${spec.title.slice(0, 60)}»`, error);
            });
        }, (error) => {
            if (!gone && !disposed)
                report(`superficie «${spec.title.slice(0, 60)}»`, error);
        });
        return {
            visible(visible) {
                if (surfaceId === null || gone)
                    return;
                call({ op: 'visible', surfaceId, visible }, false).catch(() => { });
            },
            unmount() {
                if (gone)
                    return;
                gone = true;
                if (surfaceId !== null && !disposed) {
                    call({ op: 'unmount', surfaceId }, false).catch(() => { });
                }
                surface.destroy();
            }
        };
    };
    const sections = (value) => {
        if (!Array.isArray(value))
            throw invalid('Las secciones van en una lista.');
        return value;
    };
    // ---- editor declarativo (L6) ----
    const decorationIds = new Set();
    const completionIds = new Set();
    const editorHost = (what) => {
        const editor = options.editor;
        if (!editor) {
            throw apiError('capability-not-available', `${what}: esta versión de Hebra todavía no lo ofrece a los plugins 2.0.`);
        }
        // Lo que llega por el puerto no es de fiar: el marco ya comprobó la capacidad, pero un
        // plugin puede escribir en el puerto sin pasar por el marco.
        const missing = editor.capabilityError();
        if (missing)
            throw frameError(missing);
        return editor;
    };
    const providerId = (value, taken, what) => {
        const id = text(value, `El id del proveedor de ${what}`);
        if (id === '' || id.length > PLUGIN_EDITOR_LIMITS.maxIdChars) {
            throw invalid(`El id del proveedor de ${what} tiene entre 1 y ${PLUGIN_EDITOR_LIMITS.maxIdChars} caracteres.`);
        }
        if (taken.has(id))
            throw invalid(`Ya hay un proveedor de ${what} con el id «${id.slice(0, 60)}».`);
        return id;
    };
    const handlers = {
        'handle.release': (handle) => {
            const entry = handles.get(handle);
            handles.delete(handle);
            entry?.release();
            return null;
        },
        'handle.update': (handle, patch) => {
            const entry = handles.get(handle);
            if (!entry?.update)
                throw invalid('Esa asa no se puede cambiar.');
            entry.update(patch);
            return null;
        },
        'events.subscribe': (raw) => {
            const topic = topicOf(raw);
            if (!subscriptions.has(topic))
                subscriptions.set(topic, subscribe(topic));
            return null;
        },
        'events.unsubscribe': (raw) => {
            const topic = topicOf(raw);
            const off = subscriptions.get(topic);
            subscriptions.delete(topic);
            off?.();
            return null;
        },
        'ui.registerView': (rawHandle, view) => {
            const handle = newHandle(rawHandle);
            if (!isRecord(view))
                throw invalid('La vista no es un objeto.');
            const id = text(view.id, 'El id de la vista');
            const title = text(view.title, 'El título de la vista');
            const icon = text(view.icon, 'El icono de la vista');
            const ref = callbackRef(view.surface, 'surface');
            if (view.placement === 'main') {
                const unregister = ui.registerView({
                    id,
                    title,
                    icon,
                    placement: 'main',
                    sections: sections(view.sections),
                    ...(view.retainSections === undefined
                        ? {}
                        : { retainSections: view.retainSections === true }),
                    mountSection(el, sectionId) {
                        const mounted = surfaceInto(el, ref, { kind: 'section', title, fit: 'fill' }, { section: sectionId });
                        return {
                            unmount: () => mounted.unmount(),
                            onVisibilityChange: (visible) => mounted.visible(visible)
                        };
                    }
                });
                return keep(handle, { release: unregister });
            }
            if (view.placement !== undefined &&
                view.placement !== 'column' &&
                view.placement !== 'dialog') {
                throw invalid('La colocación de la vista no es válida.');
            }
            let current = null;
            const unregister = ui.registerView({
                id,
                title,
                icon,
                ...(view.placement === undefined ? {} : { placement: view.placement }),
                mount(el) {
                    current?.unmount();
                    current = surfaceInto(el, ref, { kind: 'view', title, fit: 'auto' });
                },
                unmount() {
                    current?.unmount();
                    current = null;
                }
            });
            return keep(handle, { release: unregister });
        },
        'ui.settingsPanel': (rawHandle, panel) => {
            const handle = newHandle(rawHandle);
            if (!isRecord(panel))
                throw invalid('El panel no es un objeto.');
            const ref = callbackRef(panel.surface, 'surface');
            const unregister = ui.settingsPanel((el) => {
                const mounted = surfaceInto(el, ref, {
                    kind: 'settings',
                    title: 'Ajustes del plugin',
                    fit: 'auto'
                });
                return () => mounted.unmount();
            });
            return keep(handle, { release: unregister });
        },
        'ui.openModal': (rawHandle, surface, modalOptions) => {
            const handle = newHandle(rawHandle);
            const ref = callbackRef(surface, 'surface');
            const raw = isRecord(modalOptions) ? modalOptions : {};
            const title = raw.title === undefined ? undefined : text(raw.title, 'El título del modal');
            const closedRef = optionalRef(raw.onClosed, 'onClosed');
            let close = null;
            const modal = ui.openModal((el) => {
                const mounted = surfaceInto(el, ref, {
                    kind: 'modal',
                    title: title ?? 'Diálogo del plugin',
                    fit: 'auto'
                });
                // Con el foco DENTRO del marco, el Escape nativo no llega al `<dialog>` de Hebra: la
                // superficie lo reenvía (`key`) y Hebra lo dispara sobre su marco, que está aquí.
                const onEscape = (event) => {
                    if (event.key !== 'Escape' || event.defaultPrevented)
                        return;
                    event.preventDefault();
                    close?.();
                };
                el.addEventListener('keydown', onEscape);
                return () => {
                    el.removeEventListener('keydown', onEscape);
                    mounted.unmount();
                };
            }, {
                ...(title === undefined ? {} : { title }),
                onClosed: () => {
                    handles.delete(handle);
                    if (closedRef)
                        options.invoke(closedRef, [], false).catch(() => { });
                }
            });
            close = () => modal.close();
            return keep(handle, { release: () => modal.close() });
        },
        'editor.registerCodeBlock': (rawHandle, language, surface) => {
            const handle = newHandle(rawHandle);
            const lang = text(language, 'El lenguaje del bloque');
            const ref = callbackRef(surface, 'surface');
            const unregister = api.editor.registerCodeBlock(lang, (el, source, context) => {
                const mounted = surfaceInto(el, ref, { kind: 'codeblock', title: `Bloque «${lang.slice(0, 40)}»`, fit: 'auto' }, {
                    code: {
                        source,
                        language: context.language,
                        frontmatter: context.frontmatter
                    }
                });
                return () => mounted.unmount();
            });
            return keep(handle, { release: unregister });
        },
        'ui.tooltip': (surfaceId, tip, rect) => {
            const id = text(surfaceId, 'La superficie');
            if (tip !== null && typeof tip !== 'string')
                throw invalid('El emergente tiene que ser texto.');
            services('ui.setTooltip').tooltip(id, tip === null ? null : tip.slice(0, 500), rect);
            return null;
        },
        'ui.openExternal': (url) => services('ui.openExternal').openExternal(text(url, 'La URL')),
        'clipboard.writeText': async (value) => {
            await services('clipboard.writeText').writeClipboard(text(value, 'El texto'));
            return null;
        },
        'notify.sound.register': (id, sound) => {
            if (!isRecord(sound) || !(sound.bytes instanceof Uint8Array)) {
                throw invalid('Hace falta `bytes` (un Uint8Array).');
            }
            services('notify.sound').sound.register(text(id, 'El id del sonido'), {
                bytes: sound.bytes,
                mime: text(sound.mime, 'El tipo del sonido')
            });
            return null;
        },
        'notify.sound.play': async (id, playOptions) => {
            const volume = isRecord(playOptions) && typeof playOptions.volume === 'number' ? playOptions.volume : 1;
            return await services('notify.sound').sound.play(text(id, 'El id del sonido'), Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1)));
        },
        'notify.sound.unregister': (id) => {
            services('notify.sound').sound.unregister(text(id, 'El id del sonido'));
            return null;
        },
        'ui.revealView': (id, revealOptions) => {
            ui.revealView(id, revealOptions);
            return null;
        },
        'ui.updateView': (id, patch) => {
            ui.updateView(id, patch);
            return null;
        },
        'ui.updateViewSection': (viewId, sectionId, patch) => {
            ui.updateViewSection(viewId, sectionId, patch);
            return null;
        },
        'ui.registerCommand': (rawHandle, command) => {
            const handle = newHandle(rawHandle);
            if (!isRecord(command))
                throw invalid('El comando no es un objeto.');
            const id = text(command.id, 'El id del comando');
            const name = text(command.name, 'El nombre del comando');
            const ref = callbackRef(command.run, 'run');
            const unregister = ui.registerCommand({
                id,
                name,
                run: act(ref, `registerCommand «${id.slice(0, 60)}»`)
            });
            return keep(handle, { release: unregister });
        },
        'ui.ribbon': (rawHandle, item) => {
            const handle = newHandle(rawHandle);
            return keep(handle, { release: ui.ribbon(ribbonDefinition(item)) });
        },
        'ui.ribbonItem': (rawHandle, item) => {
            const handle = newHandle(rawHandle);
            const ribbon = ui.ribbonItem(ribbonDefinition(item));
            return keep(handle, {
                release: () => ribbon.remove(),
                update: (patch) => {
                    if (!isRecord(patch))
                        throw invalid('El cambio no es un objeto.');
                    const { onClick: _onClick, viewId: _viewId, ...rest } = patch;
                    ribbon.update(rest);
                }
            });
        },
        'ui.registerStatusBarItem': (rawHandle, item) => {
            const handle = newHandle(rawHandle);
            if (!isRecord(item))
                throw invalid('La pieza no es un objeto.');
            text(item.id, 'El id de la pieza');
            text(item.text, 'El texto de la pieza');
            const { rest, onClick } = statusBarFields(item);
            const piece = ui.registerStatusBarItem({
                ...rest,
                ...(onClick ? { onClick } : {})
            });
            return keep(handle, {
                release: () => piece.remove(),
                update: (patch) => {
                    if (!isRecord(patch))
                        throw invalid('El cambio no es un objeto.');
                    const { id: _id, ...fields } = patch;
                    const next = statusBarFields(fields);
                    piece.update({ ...next.rest, ...(next.hasClick ? { onClick: next.onClick } : {}) });
                }
            });
        },
        'ui.onReady': (rawHandle, callback) => {
            const handle = newHandle(rawHandle);
            const ref = callbackRef(callback, 'onReady');
            const ready = act(ref, 'ui.onReady');
            return keep(handle, { release: ui.onReady(() => void ready()) });
        },
        'ui.notice': (message, onClick) => {
            const ref = optionalRef(onClick, 'onClick');
            ui.notice(text(message, 'El aviso'), ref ? act(ref, 'ui.notice.onClick') : undefined);
            return null;
        },
        'ui.openMenu': (items, position) => {
            if (!Array.isArray(items))
                throw invalid('Los elementos del menú van en una lista.');
            if (!isRecord(position) ||
                typeof position.x !== 'number' ||
                typeof position.y !== 'number' ||
                !Number.isFinite(position.x) ||
                !Number.isFinite(position.y)) {
                throw invalid('La posición del menú son dos números (`x`, `y`).');
            }
            let offset = null;
            if (position.surface !== undefined) {
                offset = services('ui.openMenu').surfaceOffset(text(position.surface, 'La superficie'));
                if (!offset)
                    throw invalid('`element` no es de una superficie de este plugin.');
            }
            ui.openMenu(items.map((raw) => {
                if (!isRecord(raw))
                    throw invalid('Un elemento del menú no es un objeto.');
                if (raw.separator === true)
                    return { separator: true };
                const ref = callbackRef(raw.onClick, 'onClick');
                return {
                    label: text(raw.label, 'La etiqueta del menú'),
                    onClick: act(ref, 'ui.openMenu.onClick'),
                    ...(raw.disabled === undefined ? {} : { disabled: raw.disabled === true }),
                    ...(typeof raw.icon === 'string' ? { icon: raw.icon } : {})
                };
            }), offset
                ? { x: position.x + offset.x, y: position.y + offset.y }
                : { x: position.x, y: position.y });
            return null;
        },
        'ui.openSettings': () => {
            ui.openSettings();
            return null;
        },
        'ui.pickFolder': () => ui.pickFolder(),
        'editor.registerDecorations': (rawHandle, raw) => {
            const handle = newHandle(rawHandle);
            const editor = editorHost('editor.registerDecorations');
            if (!isRecord(raw))
                throw invalid('El proveedor de decoraciones no es un objeto.');
            const id = providerId(raw.id, decorationIds, 'decoraciones');
            const provide = callbackRef(raw.provide, 'provide');
            const click = optionalRef(raw.onClick, 'onClick');
            const clicked = click ? act(click, 'editor.registerDecorations onClick') : undefined;
            const unregister = editor.registerDecorations({
                id,
                // El resultado llega del marco SIN comprobar: lo valida quien lo pinta.
                provide: (request) => options.invoke(provide, [request], true, PLUGIN_EDITOR_LIMITS.decorationsTimeoutMs + PLUGIN_EDITOR_LIMITS.channelGraceMs),
                ...(clicked ? { onClick: (event) => void clicked(event) } : {})
            });
            decorationIds.add(id);
            return keep(handle, {
                release: () => {
                    decorationIds.delete(id);
                    unregister();
                }
            });
        },
        'editor.registerCompletion': (rawHandle, raw) => {
            const handle = newHandle(rawHandle);
            const editor = editorHost('editor.registerCompletion');
            if (!isRecord(raw))
                throw invalid('El proveedor de sugerencias no es un objeto.');
            const id = providerId(raw.id, completionIds, 'sugerencias');
            const provide = callbackRef(raw.provide, 'provide');
            const triggers = sanitizeTriggers(raw.triggers);
            const unregister = editor.registerCompletion({
                id,
                ...(triggers.length > 0 ? { triggers } : {}),
                provide: (request) => options.invoke(provide, [request], true, PLUGIN_EDITOR_LIMITS.completionTimeoutMs + PLUGIN_EDITOR_LIMITS.channelGraceMs)
            });
            completionIds.add(id);
            return keep(handle, {
                release: () => {
                    completionIds.delete(id);
                    unregister();
                }
            });
        },
        'vault.notesPage': (cursor, limit, scope) => vault.notesPage(cursor, limit, scope),
        'vault.noteRead': (id) => vault.noteRead(id),
        'vault.noteSummary': (ids) => vault.noteSummary(ids),
        'vault.noteCreate': (input) => vault.noteCreate(input),
        'vault.noteSave': (input) => vault.noteSave(input),
        'vault.notesRewriteBatch': (entries, batchOptions) => vault.notesRewriteBatch(entries, batchOptions),
        'vault.noteMove': (id, folderId) => vault.noteMove(id, folderId),
        'vault.noteMoveIfUnchanged': (id, folderId, expected) => vault.noteMoveIfUnchanged(id, folderId, expected),
        'vault.noteTrash': (id) => vault.noteTrash(id),
        'vault.noteTrashIfUnchanged': (id, expected) => vault.noteTrashIfUnchanged(id, expected),
        'vault.noteRestore': (id, expected) => vault.noteRestore(id, expected),
        'vault.noteRestoreIfUnchanged': (id, expected) => vault.noteRestoreIfUnchanged(id, expected),
        'vault.foldersList': () => vault.foldersList(),
        'vault.folderCreate': (parentId, name) => vault.folderCreate(parentId, name),
        'vault.folderRename': (id, name) => vault.folderRename(id, name),
        'vault.folderRenameIfUnchanged': (id, name, expected) => vault.folderRenameIfUnchanged(id, name, expected),
        'vault.folderMove': (id, parentId) => vault.folderMove(id, parentId),
        'vault.folderMoveIfUnchanged': (id, parentId, expected) => vault.folderMoveIfUnchanged(id, parentId, expected),
        'vault.folderTrashEmpty': (id, expected) => vault.folderTrashEmpty(id, expected),
        'vault.filesPage': (folderId, subfolders, cursor, limit) => vault.filesPage(folderId, subfolders, cursor, limit),
        'vault.fileRead': (ref) => vault.fileRead(ref),
        'vault.fileCreate': (folderId, name, sha256) => vault.fileCreate(folderId, name, sha256),
        'vault.fileReplace': (id, sha256, expectedSha256) => vault.fileReplace(id, sha256, expectedSha256),
        'vault.fileTrash': (id) => vault.fileTrash(id),
        'vault.blobRead': (sha256) => vault.blobRead(sha256),
        'vault.blobPut': (bytes, putOptions) => {
            if (!(bytes instanceof Uint8Array))
                throw invalid('blobPut recibe un Uint8Array.');
            return vault.blobPut(bytes, putOptions);
        },
        'workspace.openNote': (id, openOptions) => {
            workspace.openNote(id, openOptions);
            // Ir a otra nota a propósito suelta la fijada (T10): la instantánea lo refleja.
            recheckActive();
            return null;
        },
        'workspace.selectFolder': (id) => {
            workspace.selectFolder(id);
            return null;
        },
        'workspace.openSearch': (query) => {
            workspace.openSearch(query);
            return null;
        },
        'workspace.restart': () => workspace.restart(),
        'workspace.onBeforeFolderRename': (rawHandle, guard) => {
            const handle = newHandle(rawHandle);
            const ref = callbackRef(guard, 'guardia');
            // El tope lo pone Hebra (`withGuardDeadline` del hub): una que no responde cuenta como
            // `true` y se anota. Solo `false` cancela, como en la 1.x.
            const off = workspace.onBeforeFolderRename(async (event) => (await options.invoke(ref, [event], true)) !== false);
            return keep(handle, { release: off });
        },
        'workspace.undoTitleRename': (undo) => {
            const fn = undos.get(undo);
            undos.delete(undo);
            fn?.();
            return null;
        },
        'storage.settings.load': () => storage.settings.load(),
        'storage.settings.save': async (value) => {
            await storage.settings.save(value);
            return null;
        },
        'http.request': (request) => http.request(request),
        'http.requestUserHost': (url, hostOptions) => http.requestUserHost(url, hostOptions),
        'secrets.get': (key) => secrets.get(key),
        'secrets.set': (key, value) => secrets.set(key, value),
        'secrets.clear': (key) => secrets.clear(key),
        'tcp.listen': (port, onEvent) => {
            const ref = callbackRef(onEvent, 'onEvent');
            return tcp.listen(port, (event) => {
                options.invoke(ref, [event], false).catch(() => { });
            });
        },
        'tcp.write': (id, data) => tcp.write(id, data),
        'tcp.end': (id, data) => tcp.end(id, data),
        'tcp.destroy': (id) => tcp.destroy(id),
        'tcp.close': () => tcp.close(),
        'notify.system': (input) => notify.system(input),
        'background.hold': () => background.hold(),
        'background.release': () => background.release()
    };
    const namespaceMethod = (method) => {
        const spaces = options.namespaces ?? {};
        for (const [space, methods] of Object.entries(spaces)) {
            if (!method.startsWith(`${space}.`))
                continue;
            const name = method.slice(space.length + 1);
            if (Object.prototype.hasOwnProperty.call(methods, name))
                return methods[name];
        }
        return null;
    };
    return {
        async call(method, args) {
            if (disposed)
                throw apiError('plugin-disposed', `${String(method)}: el plugin está apagado.`);
            if (typeof method !== 'string')
                throw invalid('Método sin nombre.');
            if (!Array.isArray(args))
                throw invalid(`${method}: los argumentos van en una lista.`);
            if (Object.prototype.hasOwnProperty.call(handlers, method)) {
                const handler = handlers[method];
                const value = await handler(...args);
                return value === undefined ? null : value;
            }
            const extra = namespaceMethod(method);
            if (extra) {
                const value = await extra(args);
                return value === undefined ? null : value;
            }
            throw apiError('capability-not-available', `${method.slice(0, 120)}: esta versión de Hebra todavía no lo ofrece a los plugins 2.0.`);
        },
        activeNote: activeNoteNow,
        dispose() {
            if (disposed)
                return;
            disposed = true;
            const release = (fn, where) => {
                try {
                    fn();
                }
                catch (error) {
                    report(where, error);
                }
            };
            for (const entry of [...handles.values()])
                release(() => entry.release(), 'al apagar');
            handles.clear();
            for (const off of [...subscriptions.values()])
                release(off, 'al apagar');
            subscriptions.clear();
            for (const off of offs.splice(0))
                release(off, 'al apagar');
            undos.clear();
        }
    };
}

import { isPluginApiError } from './index.js';
import { PLUGIN_FRAME_SUBSCRIBABLE_TOPICS } from './protocol.js';
import { PLUGIN_EDITOR_LIMITS } from './editor.js';
import { frameApiError, frameError, serializeFrameError } from './wire.js';
export { frameApiError, frameError, serializeFrameError } from './wire.js';
function notYet(what) {
    return frameApiError('capability-not-available', `${what}: esta versión de Hebra todavía no lo ofrece a los plugins 2.0.`);
}
/**
 * El extremo del marco del puerto. No sabe nada de la API: llama, guarda funciones por número,
 * reparte eventos y cierra. Lo que llega antes de `boot` (salvo respuestas) se descarta: la
 * instantánea ya lo incluye.
 */
export class PluginFrameClient {
    #port;
    #hooks;
    #nextCall = 1;
    #nextCallback = 1;
    #pending = new Map();
    #callbacks = new Map();
    /** Los callbacks cuya respuesta es un dato estructurado (`provide` del editor). */
    #dataCallbacks = new Set();
    #topics = new Map();
    #booted = false;
    #closed = false;
    constructor(port, hooks) {
        this.#port = port;
        this.#hooks = hooks;
    }
    get closed() {
        return this.#closed;
    }
    /** Lo que llega por el puerto (el arranque lo engancha a `port.onmessage`). */
    receive(data) {
        if (this.#closed || typeof data !== 'object' || data === null)
            return;
        const message = data;
        switch (message.type) {
            case 'boot':
                if (this.#booted)
                    return;
                this.#booted = true;
                this.#hooks.boot(message.snapshot);
                return;
            case 'result':
            case 'error': {
                const entry = this.#pending.get(message.id);
                if (!entry)
                    return;
                this.#pending.delete(message.id);
                if (message.type === 'result')
                    entry.resolve(message.value);
                else
                    entry.reject(frameError(message.error));
                return;
            }
            case 'event':
                if (!this.#booted)
                    return;
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
    rpc(method, args, transfer) {
        return this.call(method, args, transfer);
    }
    /** Cualquier método (`runtime.*` del ciclo de vida o un espacio enchufado, L14). */
    call(method, args, transfer) {
        if (this.#closed) {
            return Promise.reject(frameApiError('plugin-disposed', `${method}: el plugin está apagado.`));
        }
        return new Promise((resolve, reject) => {
            const id = this.#nextCall++;
            this.#pending.set(id, { resolve, reject });
            try {
                this.#port.postMessage({ type: 'call', id, method, args }, transfer);
            }
            catch (error) {
                // Un argumento que no se puede clonar (una función donde no va, un nodo): es del
                // plugin, así que lo dice como argumento inválido.
                this.#pending.delete(id);
                reject(frameApiError('invalid-argument', `${method}: un argumento no puede cruzar a Hebra (${serializeFrameError(error).message}).`));
            }
        });
    }
    /**
     * Guarda `fn` para que Hebra la llame por su número. Con `data`, lo que `fn` devuelve vuelve
     * a Hebra tal cual (clonado estructurado); sin él, solo valores simples.
     */
    callback(fn, options) {
        const callback = this.#nextCallback++;
        this.#callbacks.set(callback, fn);
        if (options?.data === true)
            this.#dataCallbacks.add(callback);
        return { callback };
    }
    /** Olvida una función guardada (su registro se dio de baja). */
    release(ref) {
        if (!ref)
            return;
        this.#callbacks.delete(ref.callback);
        this.#dataCallbacks.delete(ref.callback);
    }
    /** Escucha un tema de `event`. Devuelve cómo dejar de escuchar. */
    on(topic, listener) {
        let set = this.#topics.get(topic);
        if (!set)
            this.#topics.set(topic, (set = new Set()));
        set.add(listener);
        return () => {
            set.delete(listener);
        };
    }
    /** Un fallo del plugin (un listener que lanza, un registro que Hebra rechazó). */
    fault(where, error) {
        void this.call('runtime.fault', [
            { stage: 'runtime', where, ...serializeFrameError(error) }
        ]).catch(() => { });
    }
    /** Cierra el puerto: lo pendiente rechaza con `plugin-disposed` y nada más se llama. */
    close() {
        if (this.#closed)
            return;
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
    #post(message) {
        if (this.#closed)
            return;
        try {
            this.#port.postMessage(message);
        }
        catch {
            // El valor no se puede clonar: Hebra recibe `null` en su lugar (abajo solo se mandan
            // valores simples, así que no debería pasar).
            if (message.type === 'callback-result')
                this.#port.postMessage({ ...message, value: null });
        }
    }
    #runCallback(callback, args, id) {
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
        let result;
        try {
            result = fn(...(Array.isArray(args) ? args : []));
        }
        catch (error) {
            if (answer)
                this.#post({ type: 'callback-error', id, error: serializeFrameError(error) });
            else
                this.fault('callback', error);
            return;
        }
        if (!answer) {
            if (isThenable(result))
                Promise.resolve(result).catch((error) => this.fault('callback', error));
            return;
        }
        const structured = this.#dataCallbacks.has(callback);
        Promise.resolve(result).then((value) => this.#post({
            type: 'callback-result',
            id,
            value: structured ? (value === undefined ? null : value) : simpleValue(value)
        }), (error) => this.#post({ type: 'callback-error', id, error: serializeFrameError(error) }));
    }
}
function isThenable(value) {
    return (value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof value.then === 'function');
}
/**
 * Solo valores simples vuelven a Hebra desde un callback (una guardia da `boolean`), salvo los
 * `provide` del editor declarativo (`callback(fn, { data: true })`): su respuesta es una lista
 * de rangos o un resultado de sugerencias, y Hebra la valida entera (`./editor.ts`).
 */
function simpleValue(value) {
    return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
        ? value
        : null;
}
/** Para `ui.notice` y `ui.openMenu`: callbacks que no tienen asa y se sueltan al reemplazarse. */
const MAX_NOTICE_CALLBACKS = 32;
/**
 * La API 2.0 de un plugin dentro de su marco. Congelada: el plugin no la reescribe.
 */
export function createFrameApi(options) {
    const { client } = options;
    const snapshot = options.snapshot;
    const has = snapshot.has;
    const capabilityErrors = (snapshot.capabilityErrors ?? {});
    // ---- estado de la instantánea (los eventos lo cambian ANTES de avisar) ----
    let online = snapshot.env.online;
    let isoDates = snapshot.env.isoDates;
    let activeNote = snapshot.activeNote;
    let notifyPermission = snapshot.notifyPermission;
    /** Lanza el error de una capacidad que no está (lo síncrono no espera al puerto). */
    const requireSync = (capability) => {
        const error = capabilityErrors[capability];
        if (error)
            throw frameError(error);
    };
    /** Avisa a cada listener; uno que lanza no corta a los demás y se anota como fallo. */
    const notify = (listeners, value, where) => {
        for (const listener of [...listeners]) {
            try {
                listener(value);
            }
            catch (error) {
                client.fault(where, error);
            }
        }
    };
    const listenOn = (listeners, listener, onFirst, onLast) => {
        if (typeof listener !== 'function') {
            throw frameApiError('invalid-argument', 'El listener tiene que ser una función.');
        }
        const wrapped = (value) => listener(value);
        if (listeners.size === 0)
            onFirst?.();
        listeners.add(wrapped);
        let active = true;
        return () => {
            if (!active)
                return;
            active = false;
            listeners.delete(wrapped);
            if (listeners.size === 0)
                onLast?.();
        };
    };
    // Temas que llegan siempre: la instantánea.
    const onlineListeners = new Set();
    const visibleListeners = new Set();
    const isoListeners = new Set();
    const activeNoteListeners = new Set();
    const topic = (name, handler) => {
        client.on(name, (payload) => handler(payload));
    };
    topic('env.online', (value) => {
        online = value === true;
        notify(onlineListeners, online, 'env.onOnlineChange');
    });
    topic('env.visible', (value) => notify(visibleListeners, value === true, 'env.onVisibilityChange'));
    topic('env.isoDates', (value) => {
        isoDates = value === true;
        notify(isoListeners, isoDates, 'env.onIsoDatesChange');
    });
    topic('workspace.activeNote', (event) => {
        activeNote = event.snapshot;
        if ('changed' in event) {
            notify(activeNoteListeners, event.changed, 'workspace.onActiveNoteChange');
        }
    });
    topic('notify.permission', (value) => {
        notifyPermission = value;
    });
    // Temas que se piden: el primero que escucha suscribe, el último que se va lo suelta.
    const subscribed = new Map();
    for (const name of PLUGIN_FRAME_SUBSCRIBABLE_TOPICS)
        subscribed.set(name, new Set());
    const subscribable = (name, where, listener) => {
        const listeners = subscribed.get(name);
        return listenOn(listeners, listener, () => {
            void client.rpc('events.subscribe', [name]).catch((error) => client.fault(where, error));
        }, () => {
            void client.rpc('events.unsubscribe', [name]).catch(() => { });
        });
    };
    for (const name of PLUGIN_FRAME_SUBSCRIBABLE_TOPICS) {
        client.on(name, (payload) => {
            if (name === 'workspace.noteTitleRenamed') {
                const wire = payload;
                const event = {
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
                notify(subscribed.get(name), event, name);
                return;
            }
            notify(subscribed.get(name), payload, name);
        });
    }
    // ---- registros con asa ----
    let nextHandle = 1;
    const handleRefs = new Map();
    const dropHandle = (handle) => {
        for (const ref of handleRefs.get(handle) ?? [])
            client.release(ref);
        handleRefs.delete(handle);
    };
    /** Registra en Hebra; si Hebra lo rechaza (un id que ya usa otro plugin), es un fallo. */
    const register = (method, build, onRejected) => {
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
    const releaser = (handle, after) => {
        let done = false;
        return () => {
            if (done)
                return;
            done = true;
            dropHandle(handle);
            after?.();
            void client.rpc('handle.release', [handle]).catch(() => { });
        };
    };
    const fn = (value, what) => {
        if (typeof value !== 'function') {
            throw frameApiError('invalid-argument', `${what} tiene que ser una función.`);
        }
        return value;
    };
    const text = (value, what) => {
        if (typeof value !== 'string')
            throw frameApiError('invalid-argument', `${what} tiene que ser texto.`);
        return value;
    };
    // Ids propios ya registrados: la 1.x lanza en síncrono si se repiten (`host-ui.ts`).
    const commandIds = new Set();
    const statusBarIds = new Set();
    const decorationIds = new Set();
    const completionIds = new Set();
    const pointerOf = (value) => typeof value === 'object' && value !== null ? value : undefined;
    const ribbonArgs = (handle, item) => {
        const onClick = client.callback((pointer) => item.onClick(pointerOf(pointer)));
        const { onClick: _onClick, ...rest } = item;
        return { args: [handle, { ...rest, onClick }], refs: [onClick] };
    };
    const surfacesOrThrow = (what) => {
        if (!options.surfaces)
            throw notYet(what);
        return options.surfaces;
    };
    const cleanupEntry = (result) => typeof result === 'function' ? { unmount: result } : {};
    const sectionEntry = (result) => {
        if (typeof result === 'function')
            return { unmount: result };
        if (typeof result === 'object' && result !== null) {
            const part = result;
            return {
                ...(typeof part.unmount === 'function' ? { unmount: () => part.unmount() } : {}),
                ...(typeof part.onVisibilityChange === 'function'
                    ? { visible: (v) => part.onVisibilityChange(v) }
                    : {})
            };
        }
        return {};
    };
    /** La función única que Hebra llama para montar, avisar de visibilidad y desmontar. */
    const surfaceCallback = (mountFn) => {
        const live = new Map();
        return client.callback((call) => {
            const access = options.surfaces;
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
            }
            finally {
                access.close(call.surfaceId);
            }
            return null;
        });
    };
    const tooltipOff = new WeakMap();
    let menuRefs = [];
    const noticeRefs = [];
    const ui = {
        registerView(view) {
            surfacesOrThrow('ui.registerView');
            if (typeof view !== 'object' || view === null) {
                throw frameApiError('invalid-argument', 'La vista no es un objeto.');
            }
            const id = text(view.id, 'El id de la vista');
            text(view.title, 'El título de la vista');
            text(view.icon, 'El icono de la vista');
            const placement = view.placement;
            if (placement === 'tab')
                throw notYet('ui.registerView (vistas de pestaña)');
            let wire;
            let mounted;
            if (placement === 'main') {
                const main = view;
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
            }
            else {
                const panel = view;
                fn(panel.mount, '`mount`');
                wire = {
                    id,
                    title: panel.title,
                    icon: panel.icon,
                    ...(placement === undefined ? {} : { placement: placement })
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
        registerCommand(command) {
            const id = text(command?.id, 'El id del comando');
            text(command.name, 'El nombre del comando');
            fn(command.run, '`run`');
            if (commandIds.has(id)) {
                throw new Error(`Ya hay un comando de módulo registrado con el id «${id}».`);
            }
            commandIds.add(id);
            const handle = register('ui.registerCommand', (h) => {
                const run = client.callback(() => command.run());
                return { args: [h, { id, name: command.name, run }], refs: [run] };
            }, () => commandIds.delete(id));
            return releaser(handle, () => commandIds.delete(id));
        },
        ribbon(item) {
            fn(item?.onClick, '`onClick`');
            const handle = register('ui.ribbon', (h) => ribbonArgs(h, item));
            return releaser(handle);
        },
        ribbonItem(item) {
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
        settingsPanel(mount) {
            surfacesOrThrow('ui.settingsPanel');
            fn(mount, '`mount`');
            const handle = register('ui.settingsPanel', (h) => {
                const surface = surfaceCallback((el) => cleanupEntry(mount(el)));
                return { args: [h, { surface }], refs: [surface] };
            });
            return releaser(handle);
        },
        openModal(mount, modalOptions) {
            surfacesOrThrow('ui.openModal');
            fn(mount, '`mount`');
            const handle = nextHandle++;
            const surface = surfaceCallback((el) => cleanupEntry(mount(el)));
            const closed = modalOptions?.onClosed;
            if (closed !== undefined)
                fn(closed, '`onClosed`');
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
            let ref;
            if (onClick !== undefined) {
                ref = client.callback(() => fn(onClick, '`onClick`')());
                noticeRefs.push(ref);
                // Un aviso viejo ya no se pulsa: se suelta lo más antiguo.
                while (noticeRefs.length > MAX_NOTICE_CALLBACKS)
                    client.release(noticeRefs.shift());
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
            if (tip === '')
                return;
            const show = () => {
                const surface = access.surfaceOf(el);
                if (surface === null)
                    return;
                void client
                    .rpc('ui.tooltip', [surface, tip, access.bounds(el)])
                    .catch((e) => client.fault('ui.setTooltip', e));
            };
            const hide = () => {
                const surface = access.surfaceOf(el);
                if (surface === null)
                    return;
                void client.rpc('ui.tooltip', [surface, null, null]).catch(() => { });
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
        openMenu(items, position) {
            let surface;
            if (position?.element !== undefined) {
                const found = surfacesOrThrow('ui.openMenu').surfaceOf(position.element);
                if (found === null) {
                    throw frameApiError('invalid-argument', '`element` no está en una superficie de este plugin.');
                }
                surface = found;
            }
            if (!Array.isArray(items))
                throw frameApiError('invalid-argument', 'Los elementos del menú van en una lista.');
            // Un menú nuevo sustituye al anterior: sus funciones ya no se pulsan.
            for (const ref of menuRefs)
                client.release(ref);
            menuRefs = [];
            const wire = items.map((entry) => {
                if ('separator' in entry && entry.separator === true)
                    return { separator: true };
                const item = entry;
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
        registerStatusBarItem(item) {
            const id = text(item?.id, 'El id de la pieza');
            text(item.text, 'El texto de la pieza');
            if (item.onClick !== undefined)
                fn(item.onClick, '`onClick`');
            if (statusBarIds.has(id)) {
                throw new Error(`Ya hay una pieza de la barra de estado registrada con el id «${id}».`);
            }
            statusBarIds.add(id);
            let clickRef;
            const handle = register('ui.registerStatusBarItem', (h) => {
                const { onClick, ...rest } = item;
                clickRef = onClick ? client.callback(() => onClick()) : undefined;
                return { args: [h, { ...rest, onClick: clickRef }], refs: clickRef ? [clickRef] : [] };
            }, () => statusBarIds.delete(id));
            const remove = releaser(handle, () => statusBarIds.delete(id));
            return {
                update(patch) {
                    const { onClick, ...rest } = patch ?? {};
                    let wirePatch = rest;
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
        }
    };
    /** El id de un proveedor del editor: texto no vacío, acotado y único entre los de su clase. */
    const providerId = (value, taken, what) => {
        const id = text(value, `El id del proveedor de ${what}`);
        if (id === '' || id.length > PLUGIN_EDITOR_LIMITS.maxIdChars) {
            throw frameApiError('invalid-argument', `El id del proveedor de ${what} tiene entre 1 y ${PLUGIN_EDITOR_LIMITS.maxIdChars} caracteres.`);
        }
        if (taken.has(id)) {
            throw frameApiError('invalid-argument', `Ya hay un proveedor de ${what} con el id «${id}».`);
        }
        return id;
    };
    const editor = {
        registerDecorations(provider) {
            requireSync('editor');
            const id = providerId(provider?.id, decorationIds, 'decoraciones');
            fn(provider.provide, '`provide`');
            if (provider.onClick !== undefined)
                fn(provider.onClick, '`onClick`');
            decorationIds.add(id);
            const handle = register('editor.registerDecorations', (h) => {
                const provide = client.callback((request) => provider.provide(request), {
                    data: true
                });
                const onClick = provider.onClick
                    ? client.callback((click) => provider.onClick?.(click))
                    : undefined;
                return {
                    args: [h, { id, provide, ...(onClick ? { onClick } : {}) }],
                    refs: onClick ? [provide, onClick] : [provide]
                };
            }, () => decorationIds.delete(id));
            return releaser(handle, () => decorationIds.delete(id));
        },
        registerCompletion(provider) {
            requireSync('editor');
            const id = providerId(provider?.id, completionIds, 'sugerencias');
            fn(provider.provide, '`provide`');
            if (provider.triggers !== undefined && !Array.isArray(provider.triggers)) {
                throw frameApiError('invalid-argument', '`triggers` tiene que ser una lista de caracteres.');
            }
            completionIds.add(id);
            const handle = register('editor.registerCompletion', (h) => {
                const provide = client.callback((request) => provider.provide(request), {
                    data: true
                });
                return {
                    args: [
                        h,
                        { id, provide, ...(provider.triggers ? { triggers: [...provider.triggers] } : {}) }
                    ],
                    refs: [provide]
                };
            }, () => completionIds.delete(id));
            return releaser(handle, () => completionIds.delete(id));
        },
        registerCodeBlock(language, render) {
            requireSync('editor');
            surfacesOrThrow('editor.registerCodeBlock');
            text(language, 'El lenguaje del bloque');
            fn(render, '`render`');
            const handle = register('editor.registerCodeBlock', (h) => {
                const surface = surfaceCallback((el, call) => {
                    const code = call.code;
                    return cleanupEntry(render(el, code?.source ?? '', {
                        language: code?.language ?? language,
                        frontmatter: code?.frontmatter ?? null
                    }));
                });
                return { args: [h, language, surface], refs: [surface] };
            });
            return releaser(handle);
        }
    };
    const vault = {
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
        notesRewriteBatch: (entries, batchOptions) => client.rpc('vault.notesRewriteBatch', [entries, batchOptions]),
        noteMove: (id, folderId) => client.rpc('vault.noteMove', [id, folderId]),
        noteMoveIfUnchanged: (id, folderId, expected) => client.rpc('vault.noteMoveIfUnchanged', [id, folderId, expected]),
        noteTrash: (id) => client.rpc('vault.noteTrash', [id]),
        noteTrashIfUnchanged: (id, expected) => client.rpc('vault.noteTrashIfUnchanged', [id, expected]),
        noteRestore: (id, expected) => client.rpc('vault.noteRestore', [id, expected]),
        noteRestoreIfUnchanged: (id, expected) => client.rpc('vault.noteRestoreIfUnchanged', [id, expected]),
        foldersList: () => client.rpc('vault.foldersList', []),
        folderCreate: (parentId, name) => client.rpc('vault.folderCreate', [parentId, name]),
        folderRename: (id, name) => client.rpc('vault.folderRename', [id, name]),
        folderRenameIfUnchanged: (id, name, expected) => client.rpc('vault.folderRenameIfUnchanged', [id, name, expected]),
        folderMove: (id, parentId) => client.rpc('vault.folderMove', [id, parentId]),
        folderMoveIfUnchanged: (id, parentId, expected) => client.rpc('vault.folderMoveIfUnchanged', [id, parentId, expected]),
        folderTrashEmpty: (id, expected) => client.rpc('vault.folderTrashEmpty', [id, expected]),
        filesPage: (folderId, subfolders, cursor, limit) => client.rpc('vault.filesPage', [folderId, subfolders, cursor, limit]),
        fileRead: (ref) => client.rpc('vault.fileRead', [ref]),
        fileCreate: (folderId, name, sha256) => client.rpc('vault.fileCreate', [folderId, name, sha256]),
        fileReplace: (id, sha256, expectedSha256) => client.rpc('vault.fileReplace', [id, sha256, expectedSha256]),
        fileTrash: (id) => client.rpc('vault.fileTrash', [id]),
        blobRead: (sha256) => client.rpc('vault.blobRead', [sha256]),
        blobPut(bytes, putOptions) {
            // Los bytes se TRANSFIEREN (spec §5.5.3): tras la llamada, `bytes` queda vacío aquí.
            const transfer = bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
            return client.rpc('vault.blobPut', [bytes, putOptions], transfer);
        },
        onChange(listener) {
            requireSync('vault.read');
            return subscribable('vault.change', 'vault.onChange', listener);
        }
    };
    const workspace = {
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
        onFoldersChange: (listener) => subscribable('workspace.folders', 'workspace.onFoldersChange', listener),
        onNotesChange: (listener) => subscribable('workspace.notes', 'workspace.onNotesChange', listener),
        onBeforeFolderRename(guard) {
            fn(guard, 'La guardia');
            const handle = register('workspace.onBeforeFolderRename', (h) => {
                const ref = client.callback((event) => guard(event));
                return { args: [h, ref], refs: [ref] };
            });
            return releaser(handle);
        },
        onNoteTitleRenamed: (listener) => subscribable('workspace.noteTitleRenamed', 'workspace.onNoteTitleRenamed', listener),
        restart: () => client.rpc('workspace.restart', [])
    };
    const env = {
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
    const extensionContext = {
        snapshot,
        call: (method, args, transfer) => client.call(method, args, transfer),
        on: (name, listener) => client.on(name, listener),
        fault: (where, error) => client.fault(where, error)
    };
    const settings = {
        load: () => client.rpc('storage.settings.load', []),
        save: async (value) => {
            await client.rpc('storage.settings.save', [value]);
        },
        onChange: (listener) => subscribable('storage.settings', 'storage.settings.onChange', listener)
    };
    const missingDevice = {
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
    let idb = null;
    const indexedDbProvider = options.extensions?.indexedDB;
    const loadIdb = () => {
        if (!indexedDbProvider)
            throw notYet('storage.indexedDB');
        idb ??= indexedDbProvider(extensionContext);
        return idb;
    };
    const storage = {
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
    const http = {
        request: (request) => client.rpc('http.request', [request]),
        requestUserHost: (url, hostOptions) => client.rpc('http.requestUserHost', [url, hostOptions])
    };
    const secrets = {
        // Sin id: lo pone Hebra según el puerto (M1). Aquí no hay forma de pedir el de otro.
        get: (key) => client.rpc('secrets.get', [key]),
        set: async (key, value) => {
            await client.rpc('secrets.set', [key, value]);
        },
        clear: async (key) => {
            await client.rpc('secrets.clear', [key]);
        }
    };
    let tcpRef;
    const tcp = {
        async listen(port, onEvent) {
            fn(onEvent, '`onEvent`');
            const ref = client.callback((event) => onEvent(event));
            try {
                const bound = await client.rpc('tcp.listen', [port, ref]);
                client.release(tcpRef);
                tcpRef = ref;
                return bound;
            }
            catch (error) {
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
    const soundError = () => {
        const declared = capabilityErrors['notify.sound'];
        return declared ? frameError(declared) : notYet('notify.sound');
    };
    const sound = {
        async register(id, given) {
            if (capabilityErrors['notify.sound'])
                throw soundError();
            if (!(given?.bytes instanceof Uint8Array)) {
                throw frameApiError('invalid-argument', 'Hace falta `bytes` (un Uint8Array).');
            }
            const transfer = given.bytes.buffer instanceof ArrayBuffer ? [given.bytes.buffer] : [];
            await client.rpc('notify.sound.register', [text(id, 'El id del sonido'), { bytes: given.bytes, mime: given.mime }], transfer);
        },
        play(id, playOptions) {
            if (capabilityErrors['notify.sound'])
                return Promise.reject(soundError());
            return client.rpc('notify.sound.play', [text(id, 'El id del sonido'), playOptions]);
        },
        async unregister(id) {
            if (capabilityErrors['notify.sound'])
                throw soundError();
            await client.rpc('notify.sound.unregister', [text(id, 'El id del sonido')]);
        }
    };
    const notifyApi = {
        /**
         * Síncrono, como en la 1.x: responde según el permiso de la instantánea y manda el aviso;
         * lo que diga Hebra corrige el permiso para el siguiente.
         */
        system(input) {
            requireSync('notify.system');
            if (typeof input !== 'object' ||
                input === null ||
                typeof input.title !== 'string' ||
                typeof input.body !== 'string') {
                return 'unavailable';
            }
            const predicted = notifyPermission === 'granted'
                ? 'shown'
                : notifyPermission === 'denied'
                    ? 'denied'
                    : notifyPermission === 'default'
                        ? 'pending'
                        : 'unavailable';
            if (predicted === 'denied')
                return predicted;
            const sent = {
                title: input.title,
                body: input.body,
                ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
                ...(input.silent === undefined ? {} : { silent: input.silent })
            };
            void client.rpc('notify.system', [sent]).then((outcome) => {
                if (outcome === 'shown')
                    notifyPermission = 'granted';
                else if (outcome === 'denied')
                    notifyPermission = 'denied';
            }, (error) => client.fault('notify.system', error));
            return predicted;
        },
        sound
    };
    const background = {
        hold: async () => {
            await client.rpc('background.hold', []);
        },
        release: async () => {
            await client.rpc('background.release', []);
        }
    };
    const clipboard = {
        async writeText(value) {
            const content = text(value, 'El texto');
            try {
                await client.rpc('clipboard.writeText', [content]);
            }
            catch (error) {
                // Sin la activación del gesto en Hebra, se intenta el portapapeles de la superficie.
                const fallback = options.surfaces?.writeClipboard;
                if (!isPluginApiError(error, 'user-activation-required') || !fallback)
                    throw error;
                try {
                    await fallback(content);
                }
                catch {
                    throw error;
                }
            }
        }
    };
    const markdown = {
        setProperty: (body, key, value) => options.markdown.setProperty(body, key, value),
        frontmatter: (body) => options.markdown.frontmatter(body),
        withTitle: (body, title) => options.markdown.withTitle(body, title),
        frontmatterRange: (body) => options.markdown.frontmatterRange(body)
    };
    return Object.freeze({
        apiVersion: snapshot.apiVersion,
        plugin: Object.freeze({ id: snapshot.plugin.id, version: snapshot.plugin.version }),
        has: (capability) => has[capability] === true,
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

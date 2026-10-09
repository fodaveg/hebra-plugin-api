import { PLUGIN_API_VERSION, PLUGIN_HOST_FEATURES } from './index.js';
class FakePluginApiError extends Error {
    code;
    name = 'PluginApiError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** Peticiones encadenadas que atiende una sola entrada (como Hebra): dos secciones que
 *  se piden la una a la otra no cuelgan el test. */
const MAX_CHAINED_SECTION_REQUESTS = 8;
/** Las mismas reglas que Hebra (`PluginMainViewDefinition`, «Secciones»). */
function mainSectionsProblem(view) {
    const sections = view.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
        return `Vista «${view.id}»: una vista «main» necesita al menos una sección.`;
    }
    const seen = new Set();
    for (const section of sections) {
        const valid = typeof section?.id === 'string' &&
            section.id.trim() !== '' &&
            typeof section.title === 'string' &&
            section.title.trim() !== '' &&
            !seen.has(section.id);
        if (!valid)
            return `Vista «${view.id}»: cada sección necesita \`id\` único y \`title\`.`;
        seen.add(section.id);
    }
    return typeof view.mountSection === 'function' ? null : `Vista «${view.id}»: falta mountSection.`;
}
/** Id de la carpeta raíz, el mismo que usa Hebra. */
export const FAKE_ROOT_FOLDER_ID = 'root';
const DESKTOP = ['macos', 'linux', 'windows'];
const SECRET_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const USER_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
function available(capability, platform) {
    if (capability === 'secrets')
        return platform !== 'android';
    if (capability === 'tcp' || capability === 'notify.system')
        return DESKTOP.includes(platform);
    // `http` está también en la web (por el relé de Hebra), con sus límites en `http`.
    if (capability === 'background')
        return platform !== 'web';
    return true;
}
function remover(list, item) {
    return () => {
        const index = list.indexOf(item);
        if (index >= 0)
            list.splice(index, 1);
    };
}
/** Mismo criterio que `findFrontmatterAtStart` de Hebra (ver `PluginFrontmatterRange`). */
function frontmatterRangeOf(body) {
    const firstNewline = body.indexOf('\n');
    const firstTo = firstNewline < 0 ? body.length : firstNewline + 1;
    const first = body.slice(0, firstTo).replace(/\r?\n$/u, '');
    if (first !== '---' && first !== '﻿---')
        return null;
    let cursor = firstTo;
    while (cursor < body.length) {
        const newline = body.indexOf('\n', cursor);
        const to = newline < 0 ? body.length : newline + 1;
        const line = body.slice(cursor, to).replace(/\r?\n$/u, '');
        if (line === '---' || line === '...')
            return { start: 0, end: to };
        cursor = to;
    }
    return null;
}
/** `title:` del frontmatter (sin comillas) o el primer `# …`; `''` si no hay. */
function titleOf(body) {
    const range = frontmatterRangeOf(body);
    if (range) {
        const lines = body.slice(0, range.end).split(/\r?\n/u);
        for (const line of lines) {
            const match = /^title:\s*(.*)$/u.exec(line);
            if (!match)
                continue;
            const raw = match[1].trim();
            try {
                const parsed = raw.startsWith('"') ? JSON.parse(raw) : raw;
                if (typeof parsed === 'string' && parsed.trim() !== '')
                    return parsed.trim();
            }
            catch {
                // Comillas rotas: se ignora, como un `title:` vacío.
            }
        }
    }
    const rest = range ? body.slice(range.end) : body;
    const heading = /^#[ \t]+(.+?)[ \t#]*$/mu.exec(rest);
    return heading?.[1]?.trim() ?? '';
}
/** Aproximación de `bodyWithFrontmatterTitle` de Hebra: `title: "<t>"` al final del
 *  frontmatter (o uno nuevo), el cuerpo tal cual si no se puede o ya lo tiene. */
function withTitleOf(body, title) {
    const wanted = title.trim();
    if (wanted === '' || /[\r\n]/u.test(wanted))
        return body;
    const line = `title: ${JSON.stringify(wanted)}`;
    const range = frontmatterRangeOf(body);
    let next;
    if (!range) {
        next = `---\n${line}\n---\n\n${body}`;
    }
    else {
        const block = body.slice(0, range.end);
        const lines = block.split('\n');
        const index = lines.findIndex((entry) => /^title:/u.test(entry));
        if (index >= 0) {
            lines[index] = line;
            next = lines.join('\n') + body.slice(range.end);
        }
        else {
            // Antes del delimitador de cierre (la última línea con contenido del bloque).
            const closing = block.endsWith('\n') ? lines.length - 2 : lines.length - 1;
            lines.splice(closing, 0, line);
            next = lines.join('\n') + body.slice(range.end);
        }
    }
    return next === body || titleOf(next) !== wanted ? body : next;
}
/** Hash corto y estable del cuerpo: hace las veces de `bodySha256` (no es SHA-256). */
function bodyHash(body) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < body.length; index += 1) {
        hash ^= body.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fake-${hash.toString(16).padStart(8, '0')}`;
}
function sameRevision(a, b) {
    return a.localSeq === b.localSeq && a.bodySha256 === b.bodySha256;
}
export function createFakePluginApi(options = {}) {
    const platform = options.platform ?? 'macos';
    const pluginId = options.id ?? 'plugin-de-prueba';
    const declared = new Set(['workspace', ...(options.capabilities ?? [])]);
    const requireCapability = (capability) => {
        if (!declared.has(capability)) {
            throw new FakePluginApiError('capability-not-declared', `«${capability}» sin declarar.`);
        }
        if (!available(capability, platform)) {
            throw new FakePluginApiError('unavailable-on-platform', `«${capability}» en ${platform}.`);
        }
    };
    const recorded = {
        views: [],
        mainViews: [],
        reveals: [],
        commands: [],
        ribbon: [],
        settingsPanels: [],
        statusBarItems: [],
        notices: [],
        extensions: [],
        codeBlocks: new Map(),
        httpRequests: [],
        userHostPrompts: [],
        userHostReasons: [],
        remoteBlobDownloads: []
    };
    const vaultListeners = new Set();
    /** El llavero de ESTE plugin (en Hebra, cuentas `plugin:<id>:<clave>` del dispositivo). */
    const secrets = new Map();
    const secretKey = (key) => {
        if (!SECRET_KEY_RE.test(key) || key.includes('..')) {
            throw new FakePluginApiError('invalid-argument', `«${key}» no vale como clave.`);
        }
        return key;
    };
    const notes = new Map();
    let created = 0;
    let conflicts = 0;
    const now = () => Date.now();
    /** Escribe `id` con `body`; `title` = el que dé el cuerpo, o el indicado. */
    const put = (id, body, folderId, title = titleOf(body)) => {
        const previous = notes.get(id);
        const note = {
            id,
            folderId,
            title,
            body,
            locked: false,
            createdAt: previous?.createdAt ?? now(),
            updatedAt: now(),
            favorite: previous?.favorite ?? false,
            trashedAt: null,
            archivedAt: null,
            revision: { localSeq: (previous?.revision.localSeq ?? 0) + 1, bodySha256: bodyHash(body) }
        };
        notes.set(id, note);
        return note;
    };
    /** La regla de reescritura (ver cabecera): el cuerpo manda; si no da título, se
     *  conserva solo el que no salía del cuerpo anterior. */
    const rewrite = (current, body) => {
        const derived = titleOf(body);
        const keep = derived === '' && titleOf(current.body ?? '') === '' ? current.title : derived;
        return put(current.id, body, current.folderId, keep);
    };
    for (const [id, seed] of Object.entries(options.notes ?? {})) {
        if (typeof seed === 'string')
            put(id, seed, FAKE_ROOT_FOLDER_ID);
        else
            put(id, seed.body, FAKE_ROOT_FOLDER_ID, seed.title);
    }
    const folders = [
        { id: FAKE_ROOT_FOLDER_ID, parentId: null, name: '', createdAt: 0, updatedAt: 0 }
    ];
    // Conserva las lápidas para que un padre con una hija retirada siga sin estar vacío.
    const trashedFolders = new Set();
    const files = [];
    let createdFolders = 0;
    const localBlobs = new Map(Object.entries(options.blobs ?? {}));
    const remoteOnlyBlobs = new Map(Object.entries(options.remoteBlobs ?? {}));
    const notImplemented = (what) => {
        throw new Error(`createFakePluginApi: «${what}» no está en el host falso.`);
    };
    const acceptedHosts = new Set();
    const hostDeclared = (host) => (options.hosts ?? []).some((pattern) => pattern.startsWith('*.')
        ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
        : pattern === host);
    let isoDates = options.isoDates ?? false;
    const isoListeners = new Set();
    // ---- Vistas `'main'` (1.3): lo que Hebra hace con la pantalla principal ----
    const viewTitles = new Map();
    const mainViews = new Map();
    /** La vista que «ocupa la pantalla principal» y la sección que enseña. */
    let openMain = null;
    /** La vista que el plugin acaba de desregistrar con la pantalla principal abierta: si
     *  registra el MISMO id en el mismo turno síncrono, Hebra la sigue enseñando (el cambio
     *  en caliente); con cualquier espera por medio, el modo ya se cerró. */
    let reopenMain = null;
    const callSafely = (fn) => {
        try {
            fn?.();
        }
        catch {
            // Hebra lo anota con el id del plugin y sigue; el host falso solo sigue.
        }
    };
    const unmountSection = (main, sectionId) => {
        const mounted = main.mounted.get(sectionId);
        if (!mounted)
            return;
        main.mounted.delete(sectionId);
        callSafely(() => mounted.handle.unmount?.());
        mounted.el.remove();
    };
    const setSectionVisible = (mounted, visible) => {
        if (mounted.visible === visible)
            return;
        mounted.visible = visible;
        // El orden de Hebra: «oculta» antes de ocultar; «visible» después de enseñar.
        if (visible)
            mounted.el.hidden = false;
        callSafely(() => mounted.handle.onVisibilityChange?.(visible));
        if (!visible)
            mounted.el.hidden = true;
    };
    /** El envoltorio de las secciones, como el de Hebra, colgado del documento: `el` está
     *  conectado cuando `mountSection` lo recibe. */
    const sectionContainer = (main) => {
        if (main.container?.isConnected)
            return main.container;
        const container = document.createElement('div');
        container.className = 'hebra-module-view hebra-module-view-main';
        container.dataset.moduleView = main.definition.id;
        (document.body ?? document.documentElement).append(container);
        main.container = container;
        return container;
    };
    /** Sin nada montado, el envoltorio no se queda en el documento del test. */
    const dropEmptyContainer = (main) => {
        if (main.mounted.size > 0)
            return;
        main.container?.remove();
        main.container = null;
    };
    // Como en Hebra, lo que el plugin pide desde dentro de `mountSection`, de una limpieza o
    // de un aviso de visibilidad no se atiende a medias: se guarda lo último pedido y se
    // aplica al terminar.
    let servingMain = false;
    let queuedMain = null;
    const serveMain = (request) => {
        if (servingMain) {
            queuedMain = request;
            return;
        }
        servingMain = true;
        try {
            // Si la primera lanza, lo que el plugin pidió desde dentro antes de lanzar se
            // atiende igual (como en Hebra) y el fallo sube después.
            let firstFault = null;
            try {
                request();
            }
            catch (error) {
                firstFault = { error };
            }
            for (let served = 0; queuedMain && served < MAX_CHAINED_SECTION_REQUESTS; served += 1) {
                const next = queuedMain;
                queuedMain = null;
                // El fallo de una petición encadenada no es de quien hizo la primera.
                callSafely(next);
            }
            if (firstFault)
                throw firstFault.error;
        }
        finally {
            servingMain = false;
            queuedMain = null;
        }
    };
    const leaveMainNow = () => {
        reopenMain = null;
        if (!openMain)
            return;
        const main = mainViews.get(openMain.viewId);
        openMain = null;
        if (!main)
            return;
        for (const [sectionId, mounted] of [...main.mounted]) {
            // Un aviso o una limpieza del plugin pudo desregistrar la vista: ya está desmontada.
            if (mainViews.get(main.definition.id) !== main)
                return;
            if (main.mounted.get(sectionId) !== mounted)
                continue;
            if (main.definition.retainSections)
                setSectionVisible(mounted, false);
            else
                unmountSection(main, sectionId);
        }
        dropEmptyContainer(main);
    };
    const showSectionNow = (viewId, wanted) => {
        const main = mainViews.get(viewId);
        if (!main)
            throw new Error(`createFakePluginApi: «${viewId}» no es una vista 'main'.`);
        const gone = () => mainViews.get(viewId) !== main;
        reopenMain = null;
        if (openMain && openMain.viewId !== viewId)
            leaveMainNow();
        if (gone())
            return null;
        // La pedida si existe; si no, la que ya se ve (la vista está abierta); si no, la
        // última elegida («recordada») o la primera.
        const visible = openMain?.viewId === viewId ? openMain.sectionId : undefined;
        const sectionId = [wanted, visible, main.remembered].find((id) => id !== undefined && main.sections.some((section) => section.id === id)) ?? main.sections[0].id;
        if (wanted === sectionId)
            main.remembered = sectionId;
        openMain = { viewId, sectionId };
        for (const [otherId, other] of [...main.mounted]) {
            if (otherId === sectionId)
                continue;
            if (gone())
                return null;
            if (main.mounted.get(otherId) !== other)
                continue;
            if (main.definition.retainSections)
                setSectionVisible(other, false);
            else
                unmountSection(main, otherId);
        }
        if (gone())
            return null;
        const current = main.mounted.get(sectionId);
        if (current) {
            setSectionVisible(current, true);
            return current.el;
        }
        const el = document.createElement('div');
        el.className = 'hebra-module-view-content hebra-module-view-main-content';
        el.dataset.section = sectionId;
        sectionContainer(main).append(el);
        let result;
        try {
            // Un `mountSection` que lanza sube tal cual: en Hebra la columna enseñaría el error.
            result = main.definition.mountSection(el, sectionId);
        }
        catch (error) {
            el.remove();
            if (!gone())
                dropEmptyContainer(main);
            throw error;
        }
        const handle = typeof result === 'function' ? { unmount: result } : (result ?? {});
        if (gone()) {
            // `mountSection` desregistró su propia vista: lo recién montado se deshace.
            callSafely(() => handle.unmount?.());
            el.remove();
            dropEmptyContainer(main);
            return el;
        }
        main.mounted.set(sectionId, { el, handle, visible: true });
        return el;
    };
    /** `open` y `select`: síncronas, con el `el` de vuelta; no valen desde dentro. */
    const showSection = (viewId, wanted) => {
        if (!mainViews.has(viewId)) {
            throw new Error(`createFakePluginApi: «${viewId}» no es una vista 'main'.`);
        }
        if (servingMain) {
            throw new Error('createFakePluginApi: mainView.open y mainView.select no se pueden llamar desde ' +
                'dentro de mountSection, unmount u onVisibilityChange; ahí el plugin pide otra ' +
                'sección con api.ui.revealView.');
        }
        const shown = { el: null };
        serveMain(() => {
            shown.el = showSectionNow(viewId, wanted);
        });
        // Como en Hebra, que el plugin desregistre su vista a mitad de abrirla no es un error.
        // Si ni siquiera llegó a montarse nada, el `el` que se devuelve (el tipo no admite
        // `null`) es uno vacío y ya fuera del documento.
        return shown.el ?? document.createElement('div');
    };
    const mainView = {
        open: (viewId, sectionId) => showSection(viewId, sectionId),
        select(sectionId) {
            if (!openMain)
                throw new Error('createFakePluginApi: no hay ninguna vista «main» abierta.');
            const main = mainViews.get(openMain.viewId);
            main.remembered = sectionId;
            return showSection(openMain.viewId, sectionId);
        },
        leave: () => serveMain(leaveMainNow),
        current: () => (openMain ? { ...openMain } : null),
        mounted: (viewId) => [...(mainViews.get(viewId)?.mounted.keys() ?? [])],
        sections: (viewId) => (mainViews.get(viewId)?.sections ?? []).map((section) => ({ ...section }))
    };
    const api = {
        apiVersion: PLUGIN_API_VERSION,
        plugin: { id: pluginId, version: options.version ?? '0.0.0' },
        has: (capability) => PLUGIN_HOST_FEATURES.includes(capability) ||
            (declared.has(capability) &&
                available(capability, platform)),
        env: {
            platform,
            isDesktopApp: DESKTOP.includes(platform),
            hostVersion: options.hostVersion ?? '0.0.0-fake',
            locale: () => 'es',
            online: true,
            onOnlineChange: () => () => { },
            onVisibilityChange: () => () => { },
            appleMobile: () => options.appleMobile ?? platform === 'ios',
            isoDates: () => isoDates,
            onIsoDatesChange(listener) {
                isoListeners.add(listener);
                return () => void isoListeners.delete(listener);
            }
        },
        ui: {
            registerView: (view) => {
                if (view.placement === 'main') {
                    const problem = mainSectionsProblem(view);
                    if (problem)
                        throw new FakePluginApiError('invalid-argument', problem);
                    mainViews.set(view.id, {
                        definition: view,
                        sections: view.sections.map((section) => ({ ...section })),
                        mounted: new Map(),
                        container: null
                    });
                    viewTitles.set(view.id, view.title);
                    recorded.mainViews.push(view);
                    if (reopenMain?.viewId === view.id && typeof document !== 'undefined') {
                        // Cambio en caliente: la pantalla principal sigue abierta y se vuelve a montar
                        // la sección que se veía (o la que resuelva el nuevo registro, si ya no existe).
                        openMain = reopenMain;
                        reopenMain = null;
                        // Un `mountSection` que lanza no es un fallo de `registerView`: en Hebra lo
                        // enseña la columna.
                        serveMain(() => callSafely(() => void showSectionNow(view.id)));
                    }
                    const removeMain = remover(recorded.mainViews, view);
                    return () => {
                        if (recorded.mainViews.includes(view))
                            viewTitles.delete(view.id);
                        removeMain();
                        // Como Hebra: la vista sale del registro y DESPUÉS se desmontan TODAS sus
                        // secciones, también las retenidas.
                        const main = mainViews.get(view.id);
                        if (main?.definition !== view)
                            return;
                        mainViews.delete(view.id);
                        if (openMain?.viewId === view.id) {
                            const wasOpen = openMain;
                            openMain = null;
                            reopenMain = wasOpen;
                            queueMicrotask(() => {
                                if (reopenMain === wasOpen)
                                    reopenMain = null;
                            });
                        }
                        for (const sectionId of [...main.mounted.keys()])
                            unmountSection(main, sectionId);
                        dropEmptyContainer(main);
                    };
                }
                viewTitles.set(view.id, view.title);
                recorded.views.push(view);
                const remove = remover(recorded.views, view);
                return () => {
                    if (recorded.views.includes(view))
                        viewTitles.delete(view.id);
                    remove();
                };
            },
            revealView: (id, options) => {
                recorded.reveals.push({ id, section: options?.section });
                // Una vista `'main'` entra en la pantalla principal, como en Hebra (hace falta DOM).
                // Desde dentro de `mountSection` o de un aviso, se aplica al terminar lo que
                // estaba a medias (`serveMain`).
                if (mainViews.has(id) && typeof document !== 'undefined') {
                    serveMain(() => void showSectionNow(id, options?.section));
                }
                else if (typeof document !== 'undefined' &&
                    recorded.views.some((view) => view.id === id && view.placement !== 'dialog')) {
                    // Una vista de columna con una «main» abierta: Hebra sale a las notas (sin
                    // `retainSections` se desmonta; con ella, se oculta). Una de diálogo no la toca.
                    serveMain(leaveMainNow);
                }
            },
            updateView: (id, patch) => {
                if (patch.title !== undefined && patch.title.trim() === '') {
                    throw new FakePluginApiError('invalid-argument', '`title` no puede quedar vacío.');
                }
                if (viewTitles.has(id) && patch.title !== undefined)
                    viewTitles.set(id, patch.title);
            },
            updateViewSection: (viewId, sectionId, patch) => {
                if (patch.title !== undefined && patch.title.trim() === '') {
                    throw new FakePluginApiError('invalid-argument', '`title` no puede quedar vacío.');
                }
                const section = mainViews.get(viewId)?.sections.find((entry) => entry.id === sectionId);
                if (!section)
                    return;
                if (patch.title !== undefined)
                    section.title = patch.title;
                if (patch.icon === null)
                    delete section.icon;
                else if (patch.icon !== undefined)
                    section.icon = patch.icon;
                if (patch.subtitle === null)
                    delete section.subtitle;
                else if (patch.subtitle !== undefined)
                    section.subtitle = patch.subtitle;
                if (patch.badge !== undefined)
                    section.badge = patch.badge;
            },
            registerCommand: (command) => (recorded.commands.push(command),
                remover(recorded.commands, command)),
            ribbon: (item) => (recorded.ribbon.push(item), remover(recorded.ribbon, item)),
            ribbonItem: (item) => {
                recorded.ribbon.push(item);
                return {
                    update: (patch) => Object.assign(item, patch),
                    remove: remover(recorded.ribbon, item)
                };
            },
            settingsPanel: (mount) => (recorded.settingsPanels.push(mount),
                remover(recorded.settingsPanels, mount)),
            openModal: () => ({ close: () => { } }),
            notice: (text) => void recorded.notices.push(text),
            setIcon: () => { },
            setTooltip: (el, text) => void (el.title = text),
            openMenu: () => { },
            openSettings: () => { },
            registerStatusBarItem: (item) => {
                recorded.statusBarItems.push(item);
                return {
                    update: (patch) => void Object.assign(item, patch),
                    remove: remover(recorded.statusBarItems, item)
                };
            },
            onReady: (callback) => {
                callback();
                return () => { };
            },
            openExternal: async () => { },
            pickFolder: async () => null
        },
        editor: {
            registerExtension(extension) {
                requireCapability('editor');
                recorded.extensions.push(extension);
                return remover(recorded.extensions, extension);
            },
            registerCodeBlock(language, render) {
                requireCapability('editor');
                recorded.codeBlocks.set(language, render);
                return () => void recorded.codeBlocks.delete(language);
            }
        },
        vault: {
            libraryId: () => (requireCapability('vault.read'), 'biblioteca-de-prueba'),
            rootFolderId: () => (requireCapability('vault.read'), FAKE_ROOT_FOLDER_ID),
            async notesPage() {
                requireCapability('vault.read');
                return {
                    items: [...notes.values()].map((note) => ({
                        id: note.id,
                        title: note.title,
                        excerpt: '',
                        createdAt: note.createdAt,
                        updatedAt: note.updatedAt,
                        favorite: note.favorite,
                        locked: note.locked
                    })),
                    nextCursor: null
                };
            },
            async noteRead(id) {
                requireCapability('vault.read');
                const note = notes.get(id);
                return note ? { ...note, revision: { ...note.revision } } : null;
            },
            async noteSummary(ids) {
                requireCapability('vault.read');
                // Como Hebra: solo las que existen, con la revisión y el hash que guarda la nota.
                return ids.flatMap((id) => {
                    const note = notes.get(id);
                    if (!note)
                        return [];
                    return [
                        {
                            id: note.id,
                            title: note.title,
                            excerpt: '',
                            createdAt: note.createdAt,
                            updatedAt: note.updatedAt,
                            favorite: note.favorite,
                            locked: note.locked,
                            folderId: note.folderId,
                            trashedAt: note.trashedAt,
                            archivedAt: note.archivedAt,
                            revision: { ...note.revision },
                            bodySha256: note.revision.bodySha256
                        }
                    ];
                });
            },
            async noteCreate({ folderId, body }) {
                requireCapability('vault.write');
                created += 1;
                return put(`nota-${created}`, body, folderId ?? FAKE_ROOT_FOLDER_ID);
            },
            async noteSave({ id, body, expected }) {
                requireCapability('vault.write');
                const current = notes.get(id);
                if (!current)
                    throw new Error(`createFakePluginApi: la nota «${id}» no existe.`);
                if (!sameRevision(current.revision, expected)) {
                    // Como Hebra: la nota no se pisa; lo guardado va a una copia de conflicto.
                    conflicts += 1;
                    const copy = put(`${id}-conflicto-${conflicts}`, body, current.folderId);
                    return { outcome: 'redirected', id: copy.id, revision: { ...copy.revision } };
                }
                const saved = rewrite(current, body);
                return { outcome: 'saved', id, revision: { ...saved.revision } };
            },
            async notesRewriteBatch(entries) {
                requireCapability('vault.write');
                const written = [];
                const stale = [];
                const missing = [];
                const committed = [];
                for (const entry of entries) {
                    const current = notes.get(entry.id);
                    if (!current) {
                        missing.push(entry.id);
                        stale.push(entry.id);
                        continue;
                    }
                    if (current.locked ||
                        current.trashedAt !== null ||
                        (entry.strictRevision
                            ? !sameRevision(current.revision, entry.expected)
                            : current.revision.localSeq !== entry.expected.localSeq &&
                                current.revision.bodySha256 !== entry.expected.bodySha256)) {
                        stale.push(entry.id);
                        continue;
                    }
                    const saved = rewrite(current, entry.body);
                    written.push(entry.id);
                    committed.push({ id: entry.id, body: saved.body, revision: { ...saved.revision } });
                }
                return { written, stale, ...(missing.length > 0 ? { missing } : {}), committed };
            },
            async noteMove(id, folderId) {
                requireCapability('vault.write');
                const note = notes.get(id);
                if (!note)
                    throw new Error(`createFakePluginApi: la nota «${id}» no existe.`);
                note.folderId = folderId;
                note.revision = { ...note.revision, localSeq: note.revision.localSeq + 1 };
                return { ...note, revision: { ...note.revision } };
            },
            async noteMoveIfUnchanged(id, folderId, expected) {
                requireCapability('vault.write');
                const note = notes.get(id);
                if (!note ||
                    note.locked ||
                    note.trashedAt !== null ||
                    note.folderId !== expected.folderId ||
                    !sameRevision(note.revision, expected.revision))
                    return null;
                note.folderId = folderId;
                note.revision = { ...note.revision, localSeq: note.revision.localSeq + 1 };
                return { ...note, revision: { ...note.revision } };
            },
            async noteTrash(id) {
                requireCapability('vault.write');
                const note = notes.get(id);
                if (!note)
                    throw new Error(`createFakePluginApi: la nota «${id}» no existe.`);
                note.trashedAt ??= now();
                note.revision = { ...note.revision, localSeq: note.revision.localSeq + 1 };
                return { ...note, revision: { ...note.revision } };
            },
            async noteTrashIfUnchanged(id, expected) {
                requireCapability('vault.write');
                const note = notes.get(id);
                if (!note ||
                    note.locked ||
                    note.trashedAt !== null ||
                    note.folderId !== expected.folderId ||
                    !sameRevision(note.revision, expected.revision))
                    return null;
                note.trashedAt = now();
                note.revision = { ...note.revision, localSeq: note.revision.localSeq + 1 };
                return { ...note, revision: { ...note.revision } };
            },
            async noteRestore(id, expected) {
                requireCapability('vault.write');
                const note = notes.get(id);
                if (!note ||
                    note.locked ||
                    note.trashedAt === null ||
                    note.trashedAt !== expected.trashedAt ||
                    !sameRevision(note.revision, expected.revision)) {
                    return false;
                }
                note.trashedAt = null;
                note.revision = { ...note.revision, localSeq: note.revision.localSeq + 1 };
                return true;
            },
            async noteRestoreIfUnchanged(id, expected) {
                requireCapability('vault.write');
                const note = notes.get(id);
                if (!note ||
                    note.locked ||
                    note.trashedAt === null ||
                    note.trashedAt !== expected.trashedAt ||
                    !sameRevision(note.revision, expected.revision))
                    return null;
                note.trashedAt = null;
                note.revision = { ...note.revision, localSeq: note.revision.localSeq + 1 };
                return { ...note, revision: { ...note.revision } };
            },
            async foldersList() {
                requireCapability('vault.read');
                return folders
                    .filter((folder) => !trashedFolders.has(folder.id))
                    .map((folder) => ({ ...folder }));
            },
            async folderCreate(parentId, name) {
                requireCapability('vault.write');
                createdFolders += 1;
                const folder = {
                    id: `carpeta-${createdFolders}`,
                    parentId,
                    name,
                    createdAt: now(),
                    updatedAt: now()
                };
                folders.push(folder);
                return { ...folder };
            },
            async folderRename(id, name) {
                requireCapability('vault.write');
                const folder = folders.find((entry) => entry.id === id);
                if (!folder)
                    throw new Error(`createFakePluginApi: carpeta «${id}» ausente.`);
                folder.name = name;
                return { ...folder };
            },
            async folderRenameIfUnchanged(id, name, expected) {
                requireCapability('vault.write');
                const folder = folders.find((entry) => entry.id === id);
                if (!folder ||
                    trashedFolders.has(id) ||
                    id === FAKE_ROOT_FOLDER_ID ||
                    folder.name !== expected.name ||
                    folder.parentId !== expected.parentId)
                    return null;
                folder.name = name;
                folder.updatedAt = now();
                return { ...folder };
            },
            async folderMove(id, parentId) {
                requireCapability('vault.write');
                const folder = folders.find((entry) => entry.id === id);
                if (!folder)
                    throw new Error(`createFakePluginApi: carpeta «${id}» ausente.`);
                folder.parentId = parentId;
                return { ...folder };
            },
            async folderMoveIfUnchanged(id, parentId, expected) {
                requireCapability('vault.write');
                const folder = folders.find((entry) => entry.id === id);
                if (!folder ||
                    trashedFolders.has(id) ||
                    id === FAKE_ROOT_FOLDER_ID ||
                    folder.name !== expected.name ||
                    folder.parentId !== expected.parentId)
                    return null;
                folder.parentId = parentId;
                folder.updatedAt = now();
                return { ...folder };
            },
            async folderTrashEmpty(id, expected) {
                requireCapability('vault.write');
                const folder = folders.find((entry) => entry.id === id);
                if (id === FAKE_ROOT_FOLDER_ID ||
                    !folder ||
                    trashedFolders.has(id) ||
                    folder.name !== expected.name ||
                    folder.parentId !== expected.parentId)
                    return false;
                // Una hija con lápida se puede dejar atrás; una carpeta viva o contenido en
                // cualquier nivel del subárbol (también retirado) nunca se descarta.
                const subtree = new Set([id]);
                let size = 0;
                while (size !== subtree.size) {
                    size = subtree.size;
                    for (const entry of folders)
                        if (entry.parentId && subtree.has(entry.parentId))
                            subtree.add(entry.id);
                }
                if (folders.some((entry) => entry.id !== id && subtree.has(entry.id) && !trashedFolders.has(entry.id)) ||
                    [...notes.values()].some((note) => subtree.has(note.folderId)) ||
                    files.some((file) => subtree.has(file.folderId)))
                    return false;
                trashedFolders.add(id);
                return true;
            },
            async filesPage(folderId) {
                requireCapability('vault.read');
                return { items: files.filter((file) => file.folderId === folderId), nextCursor: null };
            },
            async fileRead(ref) {
                requireCapability('vault.read');
                return files.find((file) => file.id === ref || file.name === ref) ?? null;
            },
            async fileCreate(folderId, name, sha256) {
                requireCapability('vault.write');
                const file = {
                    id: `recurso-${files.length + 1}`,
                    folderId: folderId ?? FAKE_ROOT_FOLDER_ID,
                    name,
                    sha256,
                    byteLength: 0,
                    mime: null,
                    createdAt: now(),
                    updatedAt: now(),
                    trashedAt: null
                };
                files.push(file);
                return { ...file };
            },
            fileReplace: async () => notImplemented('vault.fileReplace'),
            fileTrash: async () => notImplemented('vault.fileTrash'),
            async blobRead(sha256) {
                requireCapability('vault.read');
                let bytes = localBlobs.get(sha256);
                const remote = remoteOnlyBlobs.get(sha256);
                if (!bytes && remote) {
                    // La bajada bajo demanda: el relé entrega y el dispositivo ya lo tiene.
                    localBlobs.set(sha256, remote);
                    remoteOnlyBlobs.delete(sha256);
                    recorded.remoteBlobDownloads.push(sha256);
                    bytes = remote;
                }
                return bytes ? new Uint8Array(bytes) : null;
            },
            blobPut: async () => notImplemented('vault.blobPut'),
            onChange(listener) {
                requireCapability('vault.read');
                vaultListeners.add(listener);
                return () => void vaultListeners.delete(listener);
            }
        },
        workspace: {
            activeNote: () => null,
            onActiveNoteChange: () => () => { },
            openNote: () => { },
            selectFolder: () => { },
            openSearch: () => { },
            onFoldersChange: () => () => { },
            onNotesChange: () => () => { },
            onBeforeFolderRename: () => () => { },
            onNoteTitleRenamed: () => () => { },
            restart: async () => true
        },
        markdown: {
            setProperty: () => notImplemented('markdown.setProperty'),
            frontmatter: () => null,
            withTitle: (body, title) => withTitleOf(body, title),
            frontmatterRange: (body) => frontmatterRangeOf(body)
        },
        storage: (() => {
            let settings = null;
            const device = new Map();
            return {
                settings: {
                    load: async () => settings,
                    save: async (value) => void (settings = value),
                    onChange: () => () => { }
                },
                device: {
                    get: (key) => (device.get(key) ?? null),
                    set: (key, value) => void device.set(key, value),
                    remove: (key) => void device.delete(key)
                },
                indexedDbName: (name) => `hebra-plugin-${pluginId}-${name}`
            };
        })(),
        http: {
            async request(request) {
                requireCapability('http');
                const url = new URL(request.url);
                const host = url.hostname;
                const onWeb = platform === 'web';
                const userHost = !onWeb && !hostDeclared(host) && options.userHosts === true && acceptedHosts.has(host);
                if (!hostDeclared(host) && !userHost) {
                    throw new FakePluginApiError('host-not-declared', `«${host}» sin declarar.`);
                }
                // En la web, el relé de Hebra solo llega a hosts EXACTOS de `network.hosts`.
                if (onWeb && (url.port !== '' || !(options.hosts ?? []).includes(host))) {
                    throw new FakePluginApiError('unavailable-on-platform', `«${url.host}» en la web.`);
                }
                if (userHost && url.protocol !== 'https:') {
                    throw new FakePluginApiError('invalid-argument', `«${url.protocol}» sin https.`);
                }
                recorded.httpRequests.push(request);
                return options.http ? options.http(request) : { status: 200, headers: {}, text: '' };
            },
            async requestUserHost(raw, requestOptions) {
                requireCapability('http');
                if (platform === 'web') {
                    throw new FakePluginApiError('unavailable-on-platform', 'Sin hosts del usuario en la web.');
                }
                if (options.userHosts !== true) {
                    throw new FakePluginApiError('host-not-declared', 'Sin network.userHosts: true.');
                }
                let url;
                try {
                    url = new URL(raw);
                }
                catch {
                    throw new FakePluginApiError('invalid-argument', `URL inválida: «${raw}».`);
                }
                const host = url.hostname.toLowerCase().replace(/\.$/u, '');
                if (raw.includes('*') ||
                    url.protocol !== 'https:' ||
                    url.username !== '' ||
                    url.password !== '' ||
                    !USER_HOST_RE.test(host)) {
                    throw new FakePluginApiError('invalid-argument', `«${raw}» no vale como host.`);
                }
                const reason = requestOptions?.reason;
                if (reason !== undefined &&
                    (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 200)) {
                    throw new FakePluginApiError('invalid-argument', 'reason: texto de 1 a 200 caracteres.');
                }
                if (hostDeclared(host) || acceptedHosts.has(host))
                    return true;
                recorded.userHostPrompts.push(host);
                if (reason !== undefined)
                    recorded.userHostReasons.push(reason.trim());
                const allowed = (await options.confirmUserHost?.(host, reason?.trim())) ?? false;
                if (allowed)
                    acceptedHosts.add(host);
                return allowed;
            }
        },
        secrets: {
            get: async (key) => (requireCapability('secrets'), secretKey(key), secrets.get(key) ?? null),
            set: async (key, value) => {
                requireCapability('secrets');
                secrets.set(secretKey(key), value);
            },
            clear: async (key) => {
                requireCapability('secrets');
                secrets.delete(secretKey(key));
            }
        },
        tcp: {
            listen: async () => (requireCapability('tcp'), 0),
            write: async () => requireCapability('tcp'),
            end: async () => requireCapability('tcp'),
            destroy: async () => requireCapability('tcp'),
            close: async () => requireCapability('tcp')
        },
        notify: {
            system: () => (requireCapability('notify.system'), 'shown')
        },
        background: {
            hold: async () => requireCapability('background'),
            release: async () => requireCapability('background')
        }
    };
    return {
        api,
        recorded,
        emitVaultChange(change) {
            for (const listener of [...vaultListeners])
                listener(change);
        },
        touchNote(id, body) {
            const current = notes.get(id);
            if (!current)
                return put(id, body, FAKE_ROOT_FOLDER_ID);
            return rewrite(current, body);
        },
        acceptedUserHosts: () => [...acceptedHosts],
        revokeUserHost: (host) => void acceptedHosts.delete(host.toLowerCase()),
        setIsoDates(on) {
            if (on === isoDates)
                return;
            isoDates = on;
            for (const listener of [...isoListeners])
                listener(on);
        },
        viewTitle: (id) => viewTitles.get(id) ?? null,
        mainView
    };
}

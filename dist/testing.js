import { PLUGIN_API_VERSION } from './index.js';
class FakePluginApiError extends Error {
    code;
    name = 'PluginApiError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** Id de la carpeta raíz, el mismo que usa Hebra. */
export const FAKE_ROOT_FOLDER_ID = 'root';
const DESKTOP = ['macos', 'linux', 'windows'];
const USER_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
function available(capability, platform) {
    if (capability === 'secrets')
        return false;
    if (capability === 'tcp' || capability === 'notify.system')
        return DESKTOP.includes(platform);
    if (capability === 'http' || capability === 'background')
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
        if (capability === 'secrets') {
            throw new FakePluginApiError('capability-not-available', '«secrets» no disponible.');
        }
        if (!available(capability, platform)) {
            throw new FakePluginApiError('unavailable-on-platform', `«${capability}» en ${platform}.`);
        }
    };
    const recorded = {
        views: [],
        commands: [],
        ribbon: [],
        settingsPanels: [],
        statusBarItems: [],
        notices: [],
        extensions: [],
        codeBlocks: new Map(),
        httpRequests: [],
        userHostPrompts: []
    };
    const vaultListeners = new Set();
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
    const notImplemented = (what) => {
        throw new Error(`createFakePluginApi: «${what}» no está en el host falso.`);
    };
    const acceptedHosts = new Set();
    const hostDeclared = (host) => (options.hosts ?? []).some((pattern) => pattern.startsWith('*.')
        ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
        : pattern === host);
    let isoDates = options.isoDates ?? false;
    const isoListeners = new Set();
    const api = {
        apiVersion: PLUGIN_API_VERSION,
        plugin: { id: pluginId, version: options.version ?? '0.0.0' },
        has: (capability) => declared.has(capability) && available(capability, platform),
        env: {
            platform,
            isDesktopApp: DESKTOP.includes(platform),
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
            registerView: (view) => (recorded.views.push(view), remover(recorded.views, view)),
            revealView: () => { },
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
            noteSummary: async () => notImplemented('vault.noteSummary'),
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
                for (const entry of entries) {
                    const current = notes.get(entry.id);
                    if (!current || !sameRevision(current.revision, entry.expected)) {
                        stale.push(entry.id);
                        continue;
                    }
                    rewrite(current, entry.body);
                    written.push(entry.id);
                }
                return { written, stale };
            },
            noteMove: async () => notImplemented('vault.noteMove'),
            noteTrash: async () => notImplemented('vault.noteTrash'),
            async foldersList() {
                requireCapability('vault.read');
                return folders.map((folder) => ({ ...folder }));
            },
            folderCreate: async () => notImplemented('vault.folderCreate'),
            folderRename: async () => notImplemented('vault.folderRename'),
            folderMove: async () => notImplemented('vault.folderMove'),
            filesPage: async () => notImplemented('vault.filesPage'),
            fileRead: async () => notImplemented('vault.fileRead'),
            fileCreate: async () => notImplemented('vault.fileCreate'),
            fileReplace: async () => notImplemented('vault.fileReplace'),
            fileTrash: async () => notImplemented('vault.fileTrash'),
            blobRead: async () => notImplemented('vault.blobRead'),
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
                const userHost = !hostDeclared(host) && options.userHosts === true && acceptedHosts.has(host);
                if (!hostDeclared(host) && !userHost) {
                    throw new FakePluginApiError('host-not-declared', `«${host}» sin declarar.`);
                }
                if (userHost && url.protocol !== 'https:') {
                    throw new FakePluginApiError('invalid-argument', `«${url.protocol}» sin https.`);
                }
                recorded.httpRequests.push(request);
                return options.http ? options.http(request) : { status: 200, headers: {}, text: '' };
            },
            async requestUserHost(raw) {
                requireCapability('http');
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
                if (hostDeclared(host) || acceptedHosts.has(host))
                    return true;
                recorded.userHostPrompts.push(host);
                const allowed = (await options.confirmUserHost?.(host)) ?? false;
                if (allowed)
                    acceptedHosts.add(host);
                return allowed;
            }
        },
        secrets: {
            get: async () => (requireCapability('secrets'), null),
            set: async () => requireCapability('secrets'),
            clear: async () => requireCapability('secrets')
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
        }
    };
}

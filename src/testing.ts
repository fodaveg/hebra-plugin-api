/**
 * Host FALSO de la API (`docs/SPEC-PLUGINS-EXTERNOS.md` §5.4): un `HebraPluginApi` en
 * memoria para probar un plugin sin Hebra. Cumple el mismo tipo que la fachada real y
 * niega las capacidades igual que ella (`capability-not-declared`,
 * `unavailable-on-platform`), pero no es Hebra:
 * la biblioteca es un `Map`, `http` responde lo que diga `options.http` y lo nativo no
 * hace nada. Lo registrado queda a la vista en `fake.recorded` para afirmar sobre ello.
 *
 * Lo que SÍ imita con fidelidad, porque un plugin decide con ello:
 * - Revisiones: cada nota lleva `{ localSeq, bodySha256 }` y cada escritura las cambia.
 *   `noteSave` con una revisión vieja NO pisa la nota: guarda una COPIA de conflicto y
 *   devuelve `redirected` con su id; `notesRewriteBatch` deja en `stale` las entradas con
 *   revisión vieja o de una nota que no existe, como la fachada real.
 * - El título (regla de `PluginVault`): sale del cuerpo (`title:` del frontmatter o el
 *   primer `# …`); reescribir conserva solo un título que no salía del cuerpo si el
 *   cuerpo nuevo no da ninguno.
 * - Hosts del usuario (`http.requestUserHost`): mismas validaciones y mismos códigos.
 *
 * `markdown.withTitle` y `markdown.frontmatterRange` son una aproximación sin el lector
 * de Markdown de Hebra: bastan para frontmatter sencillo, no para casos raros de YAML.
 */
import type { Extension } from '@codemirror/state';
import {
  PLUGIN_API_VERSION,
  type HebraPluginApi,
  type PluginApiErrorCode,
  type PluginCapability,
  type PluginCodeBlockRenderer,
  type PluginCommandDefinition,
  type PluginFolder,
  type PluginFrontmatterRange,
  type PluginHttpRequest,
  type PluginHttpResponse,
  type PluginMountFn,
  type PluginNote,
  type PluginNoteRevision,
  type PluginPlatform,
  type PluginRibbonDefinition,
  type PluginStatusBarItemDefinition,
  type PluginUnregister,
  type PluginVaultChange,
  type PluginViewDefinition
} from './index';

class FakePluginApiError extends Error {
  override readonly name = 'PluginApiError' as const;
  constructor(
    readonly code: PluginApiErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** Una nota sembrada: el cuerpo, o el cuerpo y un título que no sale de él (lo que deja
 *  la importación de una nota sin `title:` ni `# …`). */
export type FakeSeedNote = string | { body: string; title: string };

export interface FakePluginApiOptions {
  id?: string;
  version?: string;
  platform?: PluginPlatform;
  /** Las capacidades declaradas (por defecto, ninguna además de las de siempre). */
  capabilities?: readonly PluginCapability[];
  /** Hosts de `network.hosts`. */
  hosts?: readonly string[];
  /** `network.userHosts` del manifiesto (por defecto `false`). */
  userHosts?: boolean;
  /** Lo que «contesta el usuario» al diálogo de `requestUserHost` (por defecto, «No
   *  permitir», como cerrar el diálogo). */
  confirmUserHost?(host: string, reason?: string): boolean | Promise<boolean>;
  /** Respuesta de `http.request` (por defecto, 200 vacío). */
  http?(request: PluginHttpRequest): Promise<PluginHttpResponse>;
  /** Notas iniciales por id, en la carpeta raíz `root`. */
  notes?: Readonly<Record<string, FakeSeedNote>>;
  /** `env.appleMobile()` (por defecto, `true` solo con `platform: 'ios'`). */
  appleMobile?: boolean;
  /** Valor inicial de `env.isoDates()` (por defecto `false`). */
  isoDates?: boolean;
  /** `env.hostVersion` (por defecto `'0.0.0-fake'`). */
  hostVersion?: string;
}

export interface FakePluginApi {
  api: HebraPluginApi;
  recorded: {
    views: PluginViewDefinition[];
    commands: PluginCommandDefinition[];
    ribbon: PluginRibbonDefinition[];
    settingsPanels: PluginMountFn[];
    statusBarItems: PluginStatusBarItemDefinition[];
    notices: string[];
    extensions: Extension[];
    codeBlocks: Map<string, PluginCodeBlockRenderer>;
    httpRequests: PluginHttpRequest[];
    /** Hosts por los que se preguntó al usuario, en orden. */
    userHostPrompts: string[];
    /** Los `reason` (ya recortados) que acompañaron esas preguntas, en orden. */
    userHostReasons: string[];
  };
  /** Dispara un cambio de la biblioteca a los `vault.onChange`. */
  emitVaultChange(change: PluginVaultChange): void;
  /** Cambia una nota «desde otro sitio» (otro dispositivo, el editor): su revisión sube,
   *  así que una escritura con la revisión anterior entra en conflicto. */
  touchNote(id: string, body: string): PluginNote;
  /** Hosts que el usuario ha permitido (el «Quitar» de Ajustes es `revokeUserHost`). */
  acceptedUserHosts(): string[];
  revokeUserHost(host: string): void;
  /** El usuario cambia «Fechas ISO»: avisa a los `env.onIsoDatesChange`. */
  setIsoDates(on: boolean): void;
}

/** Id de la carpeta raíz, el mismo que usa Hebra. */
export const FAKE_ROOT_FOLDER_ID = 'root';

const DESKTOP: readonly PluginPlatform[] = ['macos', 'linux', 'windows'];
const SECRET_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const USER_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

function available(capability: PluginCapability, platform: PluginPlatform): boolean {
  if (capability === 'secrets') return platform !== 'android';
  if (capability === 'tcp' || capability === 'notify.system') return DESKTOP.includes(platform);
  if (capability === 'http' || capability === 'background') return platform !== 'web';
  return true;
}

function remover<T>(list: T[], item: T): PluginUnregister {
  return () => {
    const index = list.indexOf(item);
    if (index >= 0) list.splice(index, 1);
  };
}

/** Mismo criterio que `findFrontmatterAtStart` de Hebra (ver `PluginFrontmatterRange`). */
function frontmatterRangeOf(body: string): PluginFrontmatterRange | null {
  const firstNewline = body.indexOf('\n');
  const firstTo = firstNewline < 0 ? body.length : firstNewline + 1;
  const first = body.slice(0, firstTo).replace(/\r?\n$/u, '');
  if (first !== '---' && first !== '﻿---') return null;
  let cursor = firstTo;
  while (cursor < body.length) {
    const newline = body.indexOf('\n', cursor);
    const to = newline < 0 ? body.length : newline + 1;
    const line = body.slice(cursor, to).replace(/\r?\n$/u, '');
    if (line === '---' || line === '...') return { start: 0, end: to };
    cursor = to;
  }
  return null;
}

/** `title:` del frontmatter (sin comillas) o el primer `# …`; `''` si no hay. */
function titleOf(body: string): string {
  const range = frontmatterRangeOf(body);
  if (range) {
    const lines = body.slice(0, range.end).split(/\r?\n/u);
    for (const line of lines) {
      const match = /^title:\s*(.*)$/u.exec(line);
      if (!match) continue;
      const raw = match[1]!.trim();
      try {
        const parsed: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw;
        if (typeof parsed === 'string' && parsed.trim() !== '') return parsed.trim();
      } catch {
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
function withTitleOf(body: string, title: string): string {
  const wanted = title.trim();
  if (wanted === '' || /[\r\n]/u.test(wanted)) return body;
  const line = `title: ${JSON.stringify(wanted)}`;
  const range = frontmatterRangeOf(body);
  let next: string;
  if (!range) {
    next = `---\n${line}\n---\n\n${body}`;
  } else {
    const block = body.slice(0, range.end);
    const lines = block.split('\n');
    const index = lines.findIndex((entry) => /^title:/u.test(entry));
    if (index >= 0) {
      lines[index] = line;
      next = lines.join('\n') + body.slice(range.end);
    } else {
      // Antes del delimitador de cierre (la última línea con contenido del bloque).
      const closing = block.endsWith('\n') ? lines.length - 2 : lines.length - 1;
      lines.splice(closing, 0, line);
      next = lines.join('\n') + body.slice(range.end);
    }
  }
  return next === body || titleOf(next) !== wanted ? body : next;
}

/** Hash corto y estable del cuerpo: hace las veces de `bodySha256` (no es SHA-256). */
function bodyHash(body: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fake-${hash.toString(16).padStart(8, '0')}`;
}

function sameRevision(a: PluginNoteRevision, b: PluginNoteRevision): boolean {
  return a.localSeq === b.localSeq && a.bodySha256 === b.bodySha256;
}

export function createFakePluginApi(options: FakePluginApiOptions = {}): FakePluginApi {
  const platform = options.platform ?? 'macos';
  const pluginId = options.id ?? 'plugin-de-prueba';
  const declared = new Set<PluginCapability>(['workspace', ...(options.capabilities ?? [])]);
  const requireCapability = (capability: PluginCapability): void => {
    if (!declared.has(capability)) {
      throw new FakePluginApiError('capability-not-declared', `«${capability}» sin declarar.`);
    }
    if (!available(capability, platform)) {
      throw new FakePluginApiError('unavailable-on-platform', `«${capability}» en ${platform}.`);
    }
  };

  const recorded: FakePluginApi['recorded'] = {
    views: [],
    commands: [],
    ribbon: [],
    settingsPanels: [],
    statusBarItems: [],
    notices: [],
    extensions: [],
    codeBlocks: new Map(),
    httpRequests: [],
    userHostPrompts: [],
    userHostReasons: []
  };
  const vaultListeners = new Set<(change: PluginVaultChange) => void>();
  /** El llavero de ESTE plugin (en Hebra, cuentas `plugin:<id>:<clave>` del dispositivo). */
  const secrets = new Map<string, string>();
  const secretKey = (key: string): string => {
    if (!SECRET_KEY_RE.test(key) || key.includes('..')) {
      throw new FakePluginApiError('invalid-argument', `«${key}» no vale como clave.`);
    }
    return key;
  };
  const notes = new Map<string, PluginNote>();
  let created = 0;
  let conflicts = 0;
  const now = (): number => Date.now();

  /** Escribe `id` con `body`; `title` = el que dé el cuerpo, o el indicado. */
  const put = (id: string, body: string, folderId: string, title = titleOf(body)): PluginNote => {
    const previous = notes.get(id);
    const note: PluginNote = {
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
  const rewrite = (current: PluginNote, body: string): PluginNote => {
    const derived = titleOf(body);
    const keep = derived === '' && titleOf(current.body ?? '') === '' ? current.title : derived;
    return put(current.id, body, current.folderId, keep);
  };
  for (const [id, seed] of Object.entries(options.notes ?? {})) {
    if (typeof seed === 'string') put(id, seed, FAKE_ROOT_FOLDER_ID);
    else put(id, seed.body, FAKE_ROOT_FOLDER_ID, seed.title);
  }
  const folders: PluginFolder[] = [
    { id: FAKE_ROOT_FOLDER_ID, parentId: null, name: '', createdAt: 0, updatedAt: 0 }
  ];
  const notImplemented = (what: string): never => {
    throw new Error(`createFakePluginApi: «${what}» no está en el host falso.`);
  };

  const acceptedHosts = new Set<string>();
  const hostDeclared = (host: string): boolean =>
    (options.hosts ?? []).some((pattern) =>
      pattern.startsWith('*.')
        ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
        : pattern === host
    );

  let isoDates = options.isoDates ?? false;
  const isoListeners = new Set<(on: boolean) => void>();

  const api: HebraPluginApi = {
    apiVersion: PLUGIN_API_VERSION,
    plugin: { id: pluginId, version: options.version ?? '0.0.0' },
    has: (capability) => declared.has(capability) && available(capability, platform),
    env: {
      platform,
      isDesktopApp: DESKTOP.includes(platform),
      hostVersion: options.hostVersion ?? '0.0.0-fake',
      locale: () => 'es',
      online: true,
      onOnlineChange: () => () => {},
      onVisibilityChange: () => () => {},
      appleMobile: () => options.appleMobile ?? platform === 'ios',
      isoDates: () => isoDates,
      onIsoDatesChange(listener) {
        isoListeners.add(listener);
        return () => void isoListeners.delete(listener);
      }
    },
    ui: {
      registerView: (view) => (recorded.views.push(view), remover(recorded.views, view)),
      revealView: () => {},
      registerCommand: (command) => (
        recorded.commands.push(command),
        remover(recorded.commands, command)
      ),
      ribbon: (item) => (recorded.ribbon.push(item), remover(recorded.ribbon, item)),
      ribbonItem: (item) => {
        recorded.ribbon.push(item);
        return {
          update: (patch) => Object.assign(item, patch),
          remove: remover(recorded.ribbon, item)
        };
      },
      settingsPanel: (mount) => (
        recorded.settingsPanels.push(mount),
        remover(recorded.settingsPanels, mount)
      ),
      openModal: () => ({ close: () => {} }),
      notice: (text) => void recorded.notices.push(text),
      setIcon: () => {},
      setTooltip: (el, text) => void (el.title = text),
      openMenu: () => {},
      openSettings: () => {},
      registerStatusBarItem: (item) => {
        recorded.statusBarItems.push(item);
        return {
          update: (patch) => void Object.assign(item, patch),
          remove: remover(recorded.statusBarItems, item)
        };
      },
      onReady: (callback) => {
        callback();
        return () => {};
      },
      openExternal: async () => {},
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
          if (!note) return [];
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
        if (!current) throw new Error(`createFakePluginApi: la nota «${id}» no existe.`);
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
        const written: string[] = [];
        const stale: string[] = [];
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
      onActiveNoteChange: () => () => {},
      openNote: () => {},
      selectFolder: () => {},
      openSearch: () => {},
      onFoldersChange: () => () => {},
      onNotesChange: () => () => {},
      onBeforeFolderRename: () => () => {},
      onNoteTitleRenamed: () => () => {},
      restart: async () => true
    },
    markdown: {
      setProperty: () => notImplemented('markdown.setProperty'),
      frontmatter: () => null,
      withTitle: (body, title) => withTitleOf(body, title),
      frontmatterRange: (body) => frontmatterRangeOf(body)
    },
    storage: (() => {
      let settings: unknown = null;
      const device = new Map<string, unknown>();
      return {
        settings: {
          load: async <T>() => settings as T | null,
          save: async (value: unknown) => void (settings = value),
          onChange: () => () => {}
        },
        device: {
          get: <T>(key: string) => (device.get(key) ?? null) as T | null,
          set: (key: string, value: unknown) => void device.set(key, value),
          remove: (key: string) => void device.delete(key)
        },
        indexedDbName: (name: string) => `hebra-plugin-${pluginId}-${name}`
      };
    })(),
    http: {
      async request(request) {
        requireCapability('http');
        const url = new URL(request.url);
        const host = url.hostname;
        const userHost =
          !hostDeclared(host) && options.userHosts === true && acceptedHosts.has(host);
        if (!hostDeclared(host) && !userHost) {
          throw new FakePluginApiError('host-not-declared', `«${host}» sin declarar.`);
        }
        if (userHost && url.protocol !== 'https:') {
          throw new FakePluginApiError('invalid-argument', `«${url.protocol}» sin https.`);
        }
        recorded.httpRequests.push(request);
        return options.http ? options.http(request) : { status: 200, headers: {}, text: '' };
      },
      async requestUserHost(raw, requestOptions) {
        requireCapability('http');
        if (options.userHosts !== true) {
          throw new FakePluginApiError('host-not-declared', 'Sin network.userHosts: true.');
        }
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          throw new FakePluginApiError('invalid-argument', `URL inválida: «${raw}».`);
        }
        const host = url.hostname.toLowerCase().replace(/\.$/u, '');
        if (
          raw.includes('*') ||
          url.protocol !== 'https:' ||
          url.username !== '' ||
          url.password !== '' ||
          !USER_HOST_RE.test(host)
        ) {
          throw new FakePluginApiError('invalid-argument', `«${raw}» no vale como host.`);
        }
        const reason = requestOptions?.reason;
        if (
          reason !== undefined &&
          (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 200)
        ) {
          throw new FakePluginApiError('invalid-argument', 'reason: texto de 1 a 200 caracteres.');
        }
        if (hostDeclared(host) || acceptedHosts.has(host)) return true;
        recorded.userHostPrompts.push(host);
        if (reason !== undefined) recorded.userHostReasons.push(reason.trim());
        const allowed = (await options.confirmUserHost?.(host, reason?.trim())) ?? false;
        if (allowed) acceptedHosts.add(host);
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
      for (const listener of [...vaultListeners]) listener(change);
    },
    touchNote(id, body) {
      const current = notes.get(id);
      if (!current) return put(id, body, FAKE_ROOT_FOLDER_ID);
      return rewrite(current, body);
    },
    acceptedUserHosts: () => [...acceptedHosts],
    revokeUserHost: (host) => void acceptedHosts.delete(host.toLowerCase()),
    setIsoDates(on) {
      if (on === isoDates) return;
      isoDates = on;
      for (const listener of [...isoListeners]) listener(on);
    }
  };
}

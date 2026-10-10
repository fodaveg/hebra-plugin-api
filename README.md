# hebra-plugin-api

API pública de los plugins de Hebra, versión `1.4.0` (`docs/SPEC-PLUGINS-EXTERNOS.md` §5 y §6 del repo de Hebra).

Este paquete vive en el repo de Hebra (`packages/plugin-api/`) y es la fuente de los tipos: la fachada de Hebra (`src/lib/plugins/api/create-plugin-api.ts`) se compila contra ellos. Se publica copiándolo al repo público `fodaveg/hebra-plugin-api`, con una etiqueta `vX.Y.Z` por versión de API (§5.4), con `node scripts/plugin-api-publish.mjs --out <dir>` desde el repo de Hebra. Ese script falla si la versión de `package.json` no es la que implementa Hebra, y añade `dist/` (el mismo código en JavaScript) para que Node pueda importar `hebra-plugin-api/build` desde el script de build de un plugin: Node no quita tipos de un `.ts` dentro de `node_modules`. Un plugin lo instala como dependencia de desarrollo: `npm install -D github:fodaveg/hebra-plugin-api#v1.2.0`.

## Qué trae

| Entrada                    | Qué es                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hebra-plugin-api`         | Tipos (`HebraPluginApi`, `HebraPluginModule` y cada fachada), `PLUGIN_CAPABILITIES`, `PLUGIN_API_ERROR_CODES` e `isPluginApiError(error, code?)`.                             |
| `hebra-plugin-api/shared`  | La lista de módulos que presta Hebra (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/common`, `@lezer/highlight`) y la clave de su registro global. |
| `hebra-plugin-api/build`   | `hebraShared()` para esbuild y `hebraSharedRollup()` para Rollup, Rolldown y Vite: cada import de un módulo prestado lee el de Hebra en vez de empaquetar otra copia.         |
| `hebra-plugin-api/testing` | `createFakePluginApi(options)`: una API en memoria para probar un plugin sin Hebra.                                                                                           |

Los tipos son TypeScript sin compilar (`src/`); el código que importa Node o empaqueta esbuild sale de `dist/` en el paquete publicado.

## Un plugin mínimo

La plantilla está en `template/`: `hebra.json`, `src/main.ts` y su `tsconfig.json`. Para un icono propio, `hebra.json` admite un `iconImage` opcional: un PNG cuadrado de 32 a 128 px y 32 KiB como máximo, embebido como `data:image/png;base64,…`. Hebra lo pinta en lugar del glifo `icon` (que sigue siendo obligatorio y es el respaldo) allí donde el plugin usa el nombre de ese `icon`; la API no cambia y las Hebra anteriores lo ignoran (`docs/SPEC-PLUGINS-EXTERNOS.md` §3.2). El módulo exporta `activate(api)`:

```ts
import type { HebraPluginApi } from 'hebra-plugin-api';

export function activate(api: HebraPluginApi) {
  api.ui.registerCommand({ id: 'saludar', name: 'Saludar', run: () => api.ui.notice('Hola.') });
}
```

Y se compila a un solo `hebra-main.mjs` con los módulos prestados fuera:

```js
import { build } from 'esbuild';
import { hebraShared } from 'hebra-plugin-api/build';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'hebra-main.mjs',
  plugins: [hebraShared()]
});
```

`hebraShared()` funciona con esbuild `>=0.17.0 <1.0.0`; están probadas la 0.17.3 (la de la plantilla de plugins de Obsidian) y la 0.28.2. Si el plugin no importa ningún módulo prestado (`"shared": {}` en `hebra.json`), `hebraShared()` no cambia nada y se puede dejar puesto.

## Capacidades y errores

`ui`, `env`, `storage`, `markdown` y `workspace` están siempre. Un `hebra.json` que declare `workspace` sigue siendo válido: Hebra lo acepta y lo ignora. El resto (`vault.read`, `vault.write`, `editor`, `http`, `secrets`, `tcp`, `notify.system`, `background`) se declara en `hebra.json`; sin declarar, cada método rechaza con `capability-not-declared`. Una capacidad declarada que la plataforma no tiene (TCP en iPhone) rechaza con `unavailable-on-platform`. `api.has(capacidad)` dice si se puede usar aquí. `secrets` guarda en el llavero del dispositivo en las apps (solo en memoria en la web; no existe en Android). `http` solo habla `https:` con los hosts de `network.hosts` y los que el usuario permite con `requestUserHost`; Hebra los vuelve a comprobar en Rust contra el `hebra.json` instalado y rechaza cualquier dirección privada o local tras resolver DNS. En la web pasa por un relé del mismo origen en `app.hebra.pro` que solo llega a los hosts EXACTOS de `network.hosts` de los plugins del listado de Hebra que se ofrecen en la web: un host que solo casa con un comodín, o con otro puerto, rechaza allí con `unavailable-on-platform`, y la respuesta tiene la misma forma que en las apps.

Nunca pongas secretos en la consulta de la URL; usa la cabecera `Authorization`. La URL entera (con su consulta) puede quedar en los registros de un servidor por el que pasa, también el relé de la web; `Authorization` no.

Los errores se reconocen con `isPluginApiError(error, 'host-not-declared')`, nunca con `instanceof`.

## Títulos de nota

El título lo deriva Hebra del cuerpo: la propiedad `title:` del frontmatter o, si no hay, el primer `# …`. `vault.noteCreate` toma el que dé el cuerpo; `vault.noteSave` y `vault.notesRewriteBatch` también (cambiar el `# …` cambia el título), y solo conservan un título que no salía del cuerpo (el nombre de fichero de una nota importada sin título) si el cuerpo nuevo no da ninguno. Para fijar el título sin tocar el encabezado: `api.markdown.withTitle(body, 'Título')`, que escribe `title: "Título"` en el frontmatter en el mismo formato que Hebra. `api.markdown.frontmatterRange(body)` da `{ start, end }` del bloque de frontmatter (`end` justo después del `---` de cierre y su salto de línea) o `null`.

## Ficheros y sus bytes

`vault.fileRead(ref)` da la fila de un fichero (nombre, `sha256`, tamaño) y `vault.blobRead(sha256)`, sus bytes. Con el sync puesto, un dispositivo puede conocer un fichero antes de haber bajado sus bytes: `blobRead` los pide entonces al relé de sync, los guarda en el dispositivo y los entrega, así que puede tardar lo que tarde la descarga (Hebra la corta, hoy, tras 30 s sin recibir datos o 15 min en total). Devuelve `null` si no se pueden conseguir ahora (sin sync, sin red o el relé todavía no los tiene): no rechaza por eso, y la siguiente llamada lo vuelve a intentar. Hasta el 7 oct 2026 respondía `null` sin intentar la descarga. Requiere `vault.read`, como siempre.

## Servidores que elige el usuario

Un plugin que habla con un servidor que no se sabe al publicarlo (un webhook, un servidor propio) declara `"network": { "hosts": [...], "userHosts": true }` y, antes de llamarlo, pide permiso:

```ts
if (await api.http.requestUserHost('https://hooks.ejemplo.com/abc')) {
  await api.http.request({ url: 'https://hooks.ejemplo.com/abc', method: 'POST', body });
}
```

La primera vez Hebra pregunta al usuario («Permitir» / «No permitir»); el sí se recuerda para ese plugin en ese dispositivo (no se sincroniza) y se puede quitar en Ajustes › Plugins. Solo `https:`, host exacto, sin comodines ni IP. Sin `userHosts: true`, `requestUserHost` rechaza con `host-not-declared`; en la web rechaza siempre con `unavailable-on-platform`: allí `http` va por el relé de Hebra, que solo llega a `network.hosts` (un host que elige el usuario lo convertiría en un proxy abierto).

## Entorno

`api.env.platform` dice qué build de Hebra corre (`'ios'` en la app de iPhone y iPad, `'web'` en el navegador). `api.env.appleMobile()` dice si el dispositivo es un iPhone o un iPad, también en la web. `api.env.isoDates()` y `api.env.onIsoDatesChange(listener)` leen el ajuste «Usar fechas ISO 8601» de Hebra. `api.vault.rootFolderId()` es el id de la carpeta raíz.

## Novedades de la 1.1

Solo se añade; un plugin con `"apiVersion": "^1.0.0"` sigue cargando.

- `PluginNoteSummary.revision` y `PluginNoteSummary.bodySha256`: la revisión y el SHA-256 del cuerpo que Hebra ya guarda con la nota, sin leer el cuerpo. `revision` es `null` si el motor no informa de ella.
- `api.env.hostVersion`: la versión de la app de Hebra (p. ej. `'0.1.0'`). No es `api.apiVersion`; para saber si una función existe, `api.has()` y `apiVersion`.
- `api.ui.pickFolder()` resuelve con el id de la carpeta (no la ruta); `null` si se cancela o se elige la raíz.
- `api.storage.indexedDbName()` de `tyrian-companion` conoce 11 nombres más (`tyrian-companion-<nombre>`).
- `api.http.requestUserHost(url, { reason })`: `reason` sale en el diálogo de permiso. No hace falta una petición después, así que se puede pedir el permiso al guardar un ajuste y no en la primera entrega:

```ts
const ok = await api.http.requestUserHost(settings.webhookUrl, {
  reason: 'Para enviar el aviso de cada entrega a tu webhook.'
});
```

- Host falso: `noteSummary`, `hostVersion` (opción) y `recorded.userHostReasons`.

## Novedades de la 1.2

`vault.folderTrashEmpty(id, { name, parentId })` marca lápida únicamente si la carpeta coincide con la identidad observada y no tiene hijas vivas ni notas o recursos en ningún descendiente; admite hijas ya retiradas y vacías al deshacer de abajo arriba. `vault.noteRestore(id, { trashedAt, revision })` restaura únicamente la nota de papelera sin cambios y sin protección. Ambas devuelven `false` cuando la condición ya no se cumple; requieren `vault.write`. Un plugin que las necesite debe comprobar que existen o declarar `"apiVersion": "^1.2.0"`.

## Novedades de la 1.3: una vista en la pantalla principal

Solo se añade; las vistas `'column'` y `'dialog'` siguen igual. Una vista con `placement: 'main'` ocupa las columnas central y de contenido de Hebra: la central enseña el título de la vista y sus secciones, que pinta Hebra, y la de contenido es del plugin.

```ts
const sections = [
  { id: 'sesion', title: 'Sesión', icon: 'timer' },
  { id: 'inventario', title: 'Inventario', icon: 'boxes' },
  { id: 'venta', title: 'Venta', icon: 'coins', badge: 2 }
];

if (api.has('ui.view.main')) {
  api.ui.registerView({
    id: 'mi-plugin',
    title: 'Mi plugin',
    icon: 'puzzle',
    placement: 'main',
    sections,
    retainSections: true, // las secciones visitadas se ocultan en vez de desmontarse
    mountSection(el, sectionId) {
      const stop = render(el, sectionId);
      return {
        unmount: stop,
        onVisibilityChange: (visible) => (visible ? resumeTimer() : pauseTimer())
      };
    }
  });
  api.ui.revealView('mi-plugin', { section: 'venta' });
  api.ui.updateViewSection('mi-plugin', 'venta', { badge: 3 });
} else {
  api.ui.registerView({ id: 'mi-plugin', title: 'Mi plugin', icon: 'puzzle', mount, unmount });
}
```

- `api.has('ui.view.main')` es una función del anfitrión, no un permiso: no la declares en `hebra.json`. En un Hebra anterior da `false` (también vale mirar `api.apiVersion`). Un Hebra anterior NO rechaza `placement: 'main'`: la registra y no la enseña, así que pregunta antes.
- Sin `retainSections`, cambiar de sección desmonta la anterior (y en un iPhone, también volver a la lista de secciones). Con ella, cada sección se monta una vez y después se oculta (`hidden`, sin salir del documento) y se enseña: `onVisibilityChange(false)` cuando deja de verse y `onVisibilityChange(true)` cuando ya vuelve a tener tamaño. No midas al recibir `false`; oculta mide 0, así que mide al recibir `true`.
- `ui.revealView` no monta nada al momento: Hebra llama a `mountSection` después, cuando el contenido va a verse (en un iPhone, cuando el usuario toca la sección o la pides con `section`). Lo que tengas que hacer con una sección va dentro de su `mountSection`.
- `el` ya está en el documento cuando lo recibes. Ocupa toda la columna de contenido, sin relleno ni ancho máximo, y se desplaza en vertical. Lleva `hebra-module-view-content hebra-module-view-main-content`; su padre, `hebra-module-view hebra-module-view-main` (ponle ahí `container-type`). El ancho lo decide la ventana: de menos de 400 px en un iPhone a más de 1000.
- `ui.revealView(id, { section })` entra en esa sección y la deja como la recordada del dispositivo (se borra al desinstalar el plugin con sus datos). Si la vista ya está abierta, `ui.revealView(id)` sin sección, o con una que no existe, no cambia la que se ve; si no lo está, entra en la recordada o en la primera.
- Desde dentro de `mountSection`, de su limpieza o de `onVisibilityChange` puedes llamar a `ui.revealView`, `ui.updateView` y `ui.updateViewSection`, y desregistrar la vista: un cambio de sección pedido ahí se aplica al terminar lo que estaba a medias.
- `ui.updateView(id, { title })` y `ui.updateViewSection(viewId, sectionId, { title, icon, subtitle, badge })` cambian lo declarado sin desregistrar. Añadir o quitar secciones exige registrar la vista otra vez; si desregistras y registras el mismo `id` en el mismo momento con la vista abierta, sigue abierta y se vuelve a montar la sección que se veía.
- Para ofrecer «barra lateral / pantalla principal», desregistra y registra con el otro sitio; Hebra desmonta lo que hubiera y vuelve a las notas.
- Un botón de `ribbon` con el `viewId` de una vista `'main'` refleja `aria-pressed` mientras está abierta; el clic llama siempre a `onClick`.
- Host falso: `fake.mainView.open(id, section?)`, `select(section)`, `leave()`, `current()`, `mounted(id)` y `sections(id)`; `fake.viewTitle(id)`; `recorded.reveals` y `recorded.mainViews` (las vistas `'main'` no van en `recorded.views`, que sigue siendo solo de `'column'` y `'dialog'`). Necesita `document` (jsdom o happy-dom). Monta en síncrono dentro de `revealView`, `open` y `select`, y un `mountSection` que lanza sube por ahí; Hebra monta después y no lanza. El cambio en caliente (desregistrar y registrar el mismo id con la vista abierta) lo da por «en el mismo momento» si es el mismo turno síncrono; Hebra, si es el mismo pintado (JSDoc de `FakePluginApi.mainView`).

## Novedades de la 1.4: imágenes remotas en línea

Solo se añade. Una imagen Markdown con destino `https` se pinta dentro de su línea en la nota: en un párrafo, en una línea de lista y en una celda de tabla. Es Markdown normal, lo escribe el plugin en la nota con `vault.write`; no hay ningún método nuevo.

```ts
// Un Hebra anterior enseñaría «Espada|20» en vez del icono: ahí no se escribe.
const icons = api.has('markdown.image.remote');
const icon = (name: string, url: string, inTable = false) =>
  icons ? `![${name}${inTable ? '\\|20' : '|20'}](${url})` : '';

const line = `- ${icon('Espada', 'https://render.guildwars2.com/file/….png')} Espada`;
const row = `| Espada | ${icon('Espada', 'https://render.guildwars2.com/file/….png', true)} |`;
```

- `api.has('markdown.image.remote')` es una función del anfitrión, no un permiso: no la declares en `hebra.json` ni pidas `http` ni `network.hosts` por ella (la imagen la pide la nota, no el plugin). En un Hebra anterior da `false` y la misma línea enseña el texto alternativo con el `|20` a la vista, así que pregunta antes de escribirla.
- Solo `https:`, de cualquier servidor. `http:`, `data:` y `blob:` no se cargan: se ve el texto alternativo.
- Tamaño, con la sintaxis de Obsidian, al final del texto alternativo: `![alt|24](url)` es el ancho en px y `![alt|24x24](url)` ancho y alto. Enteros de 1 a 4096; cualquier otra cosa tras la barra es texto alternativo (`![a|b](url)` → «a|b»). Sin tamaño, la imagen va a su tamaño natural sin pasar del ancho de la línea.
- En una celda de tabla la barra va ESCAPADA, `![alt\|24](url)`: sin la barra invertida parte la celda en dos. Fuera de una tabla valen las dos formas.
- Para un icono dentro de una línea de texto, declara un lado de hasta 24 px (`|20` o `|20x20`): la línea mide lo mismo que sus vecinas sin icono, antes y después de cargar. Por encima de 24 px, o sin tamaño, la línea crece lo que pida la imagen. Con `|N` solo, el alto sigue la proporción de la imagen: si no es cuadrada, declara `|NxM`.
- El `|24` no es texto: no sale en el extracto de la lista, en la búsqueda, en el índice ni en las copias.
- Respaldo: si la imagen no carga (404, sin red) queda su texto alternativo, o «Imagen» si está vacío. Pon siempre un alternativo que se entienda solo.
- Con el cursor tocando la imagen se ve su Markdown; en la vista «Código fuente» no se pide ninguna imagen.
- El usuario puede apagar «Cargar imágenes remotas» en Ajustes: entonces la nota enseña el texto alternativo y `api.has('markdown.image.remote')` sigue dando `true` (dice lo que Hebra sabe hacer, no lo que el usuario ha elegido).
- La petición la hace el motor web directamente al servidor de la imagen, sin `Referer` y sin los parámetros de rastreo de la URL (`utm_*`, `fbclid`, `gclid`…, que la nota conserva). Hebra no la descarga ni la guarda como adjunto, así que sin red no se ve.
- Host falso: `fake.api.has('markdown.image.remote')` da `true`.

## Host falso

`createFakePluginApi()` imita lo que un plugin decide con ello: revisiones de nota (una `noteSave` con revisión vieja guarda una copia de conflicto y devuelve `redirected`; `notesRewriteBatch` devuelve en `stale` las de revisión vieja o que no existen, y además en `missing` las que no existen: no merece reintentarlas), la regla del título, los hosts del usuario (`confirmUserHost`, `revokeUserHost`) las fechas ISO (`setIsoDates`) y `vault.blobRead`: devuelve los bytes de un blob sembrado con `blobs: { [sha256]: bytes }` o `null` si no está, y con `remoteBlobs: { [sha256]: bytes }` siembra blobs «solo remotos» que la primera lectura «baja» (queda anotado en `recorded.remoteBlobDownloads`) para probar la bajada bajo demanda.

Como el registro de Hebra, lanza si el id sigue registrado en `ui.registerView` (también entre colocaciones `'column'`, `'dialog'` y `'main'`), `ui.registerCommand`, `ui.registerStatusBarItem` y `editor.registerCodeBlock` (el lenguaje se compara recortado y en minúsculas); tras desregistrar, el id vuelve a valer. `ribbon`, `ribbonItem`, `settingsPanel` y `registerExtension` admiten repetidos, como en Hebra. Diferencia: Hebra comparte los ids entre plugins; el falso solo conoce al que pruebas.

Los métodos `noteTrashIfUnchanged` y `noteMoveIfUnchanged` reciben la revisión y carpeta observadas; `noteRestoreIfUnchanged`, la revisión y fecha de papelera. Devuelven la nota confirmada o `null` sin efectos si cambió o está protegida. `folderRenameIfUnchanged` y `folderMoveIfUnchanged` comparan nombre y padre y devuelven la carpeta confirmada o `null`. Todos requieren `vault.write`. `noteRestore` conserva su resultado booleano.

`notesRewriteBatch` conserva `written` y `stale` y añade `committed: {id, body, revision}[]`, capturado dentro de la misma transacción. `body` es el texto guardado, incluido el orden de tareas que aplique Hebra, y `revision` corresponde a ese texto.

Para deshacer texto, cada entrada de `notesRewriteBatch` puede pedir `strictRevision: true`: exige secuencia **y** hash, incluidos los cambios externos que guardan el mismo texto. Sin esa bandera conserva la comparación histórica por secuencia **o** hash.

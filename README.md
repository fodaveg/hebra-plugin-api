# hebra-plugin-api

API pública de los plugins de Hebra. El paquete es la versión `2.1.0` (sin publicar: la etiqueta la decide David; la 2.1.0 añade `clickModifier` a las decoraciones) y lleva DOS APIs que conviven: la 1.x de siempre en la raíz (`1.7.0`, no cambia) y la 2.0 en `hebra-plugin-api/v2` (`docs/SPEC-PLUGINS-EXTERNOS.md` §5 y §6 del repo de Hebra).

Este paquete vive en el repo de Hebra (`packages/plugin-api/`) y es la fuente de los tipos: la fachada de Hebra (`src/lib/plugins/api/create-plugin-api.ts`) se compila contra ellos. Se publica copiándolo al repo público `fodaveg/hebra-plugin-api`, con una etiqueta `vX.Y.Z` por versión de API (§5.4), con `node scripts/plugin-api-publish.mjs --out <dir>` desde el repo de Hebra. Ese script falla si la 1.x de Hebra no es la de los tipos, si la 2.0 de Hebra no es la de `v2`, o si la versión de `package.json` no es la de la 2.0 (la mayor de las dos; la etiqueta es `v2.0.0`), y añade `dist/` (el mismo código en JavaScript) para que Node pueda importar `hebra-plugin-api/build` desde el script de build de un plugin: Node no quita tipos de un `.ts` dentro de `node_modules`. Un plugin lo instala como dependencia de desarrollo: `npm install -D github:fodaveg/hebra-plugin-api#v1.2.0` (1.x) o `#v2.0.0` (1.x y 2.0).

## Qué trae

| Entrada                       | Qué es                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hebra-plugin-api`            | Tipos (`HebraPluginApi`, `HebraPluginModule` y cada fachada), `PLUGIN_CAPABILITIES`, `PLUGIN_API_ERROR_CODES` e `isPluginApiError(error, code?)`.                             |
| `hebra-plugin-api/shared`     | La lista de módulos que presta Hebra (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/common`, `@lezer/highlight`) y la clave de su registro global. |
| `hebra-plugin-api/build`      | `hebraShared()` para esbuild y `hebraSharedRollup()` para Rollup, Rolldown y Vite: cada import de un módulo prestado lee el de Hebra en vez de empaquetar otra copia.         |
| `hebra-plugin-api/testing`    | `createFakePluginApi(options)`: una API en memoria para probar un plugin sin Hebra.                                                                                           |
| `hebra-plugin-api/v2`         | La API 2.0 (plugin aislado en un marco): tipos, `PLUGIN_API_VERSION` (`2.1.0`), `PLUGIN_API_ERROR_CODES` e `isPluginApiError`. No exige `@codemirror/state`.                  |
| `hebra-plugin-api/v2/testing` | `createFakePluginApiV2(options)`: el host falso de la 2.0.                                                                                                                    |

Los tipos son TypeScript sin compilar (`src/`); el código que importa Node o empaqueta esbuild sale de `dist/` en el paquete publicado.

## API 2.0: `hebra-plugin-api/v2`

La 2.0 es la API de un plugin que corre AISLADO: en su propio origen, dentro de un marco, sin acceso al DOM, al `localStorage`, al IndexedDB ni a la IPC de Hebra. Todo lo que hace pasa por la API, que cruza un puerto (`MessagePort`) hacia Hebra. Detalle en `docs/SPEC-PLUGINS-EXTERNOS.md`: §5.5 (la 2.0 y sus subsecciones), §6.1 (sin préstamo y editor declarativo) y §8.1 (modelo de seguridad). Aquí solo lo que hay que saber para usarla.

Nada de la 1.x cambia: `hebra-plugin-api`, `/shared`, `/build` y `/testing` son los mismos, un plugin 1.x compila y corre igual y Hebra sigue ejecutándolo como hasta ahora mientras haya plugins en la 1.x (conviven). Un plugin migra cambiando `from 'hebra-plugin-api'` por `from 'hebra-plugin-api/v2'` y arreglando lo que señale el compilador; los nombres de los tipos son los de la 1.x.

```ts
import { isPluginApiError, type HebraPluginApi } from 'hebra-plugin-api/v2';
import { createFakePluginApiV2 } from 'hebra-plugin-api/v2/testing'; // en los tests

export async function activate(api: HebraPluginApi): Promise<void> {
  api.ui.registerCommand({ id: 'hola', name: 'Hola', run: () => api.ui.notice(api.plugin.id) });
}
```

`createFakePluginApiV2({ id, capabilities })` devuelve `{ api, dispose, … }` y se usa como el falso de la 1.x. `hebra.json` pide la 2.0 con `apiVersion`: un rango de mayor 2 (`"apiVersion": "^2.0.0"`) hace que Hebra ejecute el plugin aislado; la mayor la decide la cota inferior del rango, así que un `>=1.5.0` escrito para la 1.x sigue siendo 1.x. Una Hebra que solo implementa la 1.x deja un plugin 2.0 instalado y apagado («Necesita una versión más nueva de Hebra»). Hoy la 2.0 va detrás de una marca de build de Hebra, apagada en producción hasta que se acepte (§5.5.1).

### Qué cambia respecto a la 1.x

- **Sin `registerExtension`.** La 2.0 no presta CodeMirror ni deja extender el editor: el plugin dice QUÉ y Hebra lo ejecuta en su editor. `editor.registerDecorations({ id, provide, onClick? })` pinta rangos con un juego fijo de estilos (`link`, `accent`, `muted`, `warning`, `danger`) y `editor.registerCompletion({ id, triggers?, provide })` ofrece sugerencias. `editor.registerCodeBlock` conserva su firma (§6.1).
- **Superficies en lugar de `document`.** El código del plugin corre en un marco de ejecución oculto; lo que se ve (vistas, panel de ajustes, modal, bloque de código) es una superficie, y `mount(el)` entrega un `el` de otro documento: `el.ownerDocument` no es `document` y `instanceof HTMLElement` da `false` entre marcos. Lo que pinta Hebra y llama al plugin entrega el clic serializado (`PluginPointerInfo`), no un `MouseEvent` (§5.5.2).
- **`storage.indexedDB` y `storage.device`.** Una fábrica IndexedDB cuyos datos guarda Hebra (con `storage.IDBKeyRange` y `storage.indexedDbName(name)`), y `storage.device` con `get` síncrono sobre un espejo, `set`/`remove` inmediatos y `flush()` nuevo. `window.indexedDB` y `localStorage` del marco no persisten en todas partes: no se usan. Topes por plugin: 128 MiB de IndexedDB y 1 MiB de `storage.device` (§5.5.4).
- **`ui.openExternal(url)`** con confirmación: la primera vez que un plugin abre un dominio, Hebra enseña la URL entera y pregunta (casilla «No volver a preguntar para este dominio», por dispositivo). Resuelve `'opened'` o `'cancelled'`; solo `https:` y `http:` (§5.5.2).
- **`notify.sound`**: capacidad nueva, solo con `apiVersion` 2.x. `register(id, { bytes, mime })` una vez y `play(id, { volume })` después; lo reproduce Hebra, el usuario puede silenciarlo (`'muted'`) (§5.5.6, punto 3).
- **`network.images`** en `hebra.json`: hosts exactos `https` desde los que las superficies pueden cargar `<img>`; la CSP del marco solo permite `'self'`, `data:` y `blob:` más esos hosts (§5.5.6, punto 1).
- **Otros cambios que el compilador señala:** `api.clipboard.writeText` (lo escribe Hebra, con gesto del usuario; sin él, `user-activation-required`), `shared` vacío en el manifiesto, y los errores no incluyen `extension-rechazada`.

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

## Novedades de la 1.7: una vista del plugin como contenido de pestaña (sin publicar)

Solo se añade. Una vista con `placement: 'tab'` se enseña en la columna de contenido como una pestaña más, junto a las notas, los ficheros y las Bases: se fija, se reordena, se cierra, se reabre y vuelve al arrancar. No es la vista `'main'` (un modo de la barra lateral, nunca una pestaña) ni la pestaña del inspector (`'column'`).

```ts
if (api.has('ui.view.tab')) {
  api.ui.registerView({
    id: 'indice',
    title: 'Índice',
    icon: 'list',
    placement: 'tab',
    mount(el, ctx) {
      const area = render(el, ctx.key, ctx.state); // ctx.state: lo guardado, o null
      area.onScroll((y) => ctx.setState({ y })); // vuelve en ctx.state al montar otra vez
      ctx.setTitle(`Índice ${ctx.key}`);
      return () => area.destroy();
    }
  });
  api.workspace.openView('indice', { key: '21.05', state: { y: 0 }, newTab: true });
}
```

- `api.has('ui.view.tab')` es una función del anfitrión, no un permiso: no la declares en `hebra.json`. En un Hebra anterior da `false` y `workspace.openView` no existe; un Hebra anterior registra `placement: 'tab'` sin enseñarlo en ningún sitio, así que pregunta antes (o pide `"apiVersion": "^1.7.0"`).
- La identidad de una pestaña es plugin + vista + `key` (por defecto `''`): `openView` con una clave que ya tiene pestaña la activa tal cual, sin cambiar su estado. Claves distintas son pestañas distintas de la misma vista.
- `openView(id, { key, state, title, newTab })`: sin `newTab`, sustituye lo que enseña la pestaña activa (si está fijada, abre una nueva); con `newTab: true`, en una pestaña nueva y activa (con 50 avisa y no abre). Solo el iPhone no tiene pestañas: ahí `newTab` se ignora y la vista ocupa la columna de contenido. `ui.revealView(id)` de una vista de pestaña abre la de clave `''` en la pestaña activa (es lo que hace «Abrir «‹título›»» de la paleta).
- Lanza `invalid-argument` si `id` no es una vista de pestaña registrada por TU plugin, si `key` o `title` pasan de 200 caracteres, o si `state` no es JSON (`PluginJsonValue`) o pasa de 8 KiB (`PLUGIN_TAB_VIEW_STATE_MAX_BYTES`, bytes UTF-8 de su `JSON.stringify`).
- `mount(el, ctx)` es síncrona y se llama cuando la pestaña pasa a verse; al dejar de verse (otra pestaña, Bases u otro modo en la columna, cerrarla, apagar el plugin) Hebra llama a la limpieza que devolviste (una función o `{ unmount }`) y `el` sale del documento. Lo que quieras conservar, en `ctx.setState`: vuelve en `ctx.state` al montar otra vez, al reabrir la pestaña y tras cerrar y abrir Hebra (se guarda en el dispositivo, no se sincroniza). `ctx.setTitle(título)` cambia el de ESA pestaña (`null` o `''`: el de la vista). Tras desmontar, los dos no hacen nada.
- `el` lleva `hebra-module-view-content hebra-module-view-tab-content` y `data-key`; su padre, `hebra-module-view hebra-module-view-tab` (ponle ahí `container-type`). Ocupa la columna de contenido bajo la tira, sin relleno ni ancho máximo, y se desplaza en vertical.
- Un `mount` que lanza no tumba Hebra: se anota con el id de tu plugin y la pestaña enseña «No se pudo abrir ‹título›» con «Reintentar».
- Desregistrar la vista desmonta sus pestañas, que esperan («Abriendo…»); registrarla otra vez con el mismo id las vuelve a montar con su estado. Apagar o desinstalar el plugin CIERRA sus pestañas, y al arrancar solo vuelven las de un plugin instalado y encendido.
- Mientras una pestaña de vista está activa, `workspace.activeNote()` es `null` y `onActiveNoteChange` avisa con `null`. El menú de la pestaña no ofrece «Abrir en nueva ventana» ni «Mostrar en la carpeta». La pestaña lleva el icono de la vista (tu `iconImage` si es el `icon` de tu manifiesto) y «, vista de plugin» en su nombre accesible. Un botón de `ribbon` con el `viewId` de una vista de pestaña no refleja `aria-pressed` (todavía).
- Host falso: `fake.api.has('ui.view.tab')` da `true`; las vistas van a `recorded.tabViews` (no a `recorded.views`), cada `openView` aceptado a `recorded.viewOpens` (valida como Hebra), y `fake.tabView.mount(id, { key, state })` monta la vista como al activar su pestaña y devuelve `{ el, state(), title(), unmount() }`. No imita la tira, la persistencia ni cuándo monta Hebra; un `mount` que lanza sube por ahí.

## Novedades de la 1.6: `workspace.openNote` con pestaña nueva (sin publicar)

Solo se añade. `workspace.openNote(id, options?)` admite una opción; un Hebra anterior a la 1.6 la ignora y abre la nota como siempre (en la pestaña activa).

```ts
api.workspace.openNote(id, { newTab: true });
```

- `newTab: true` abre la nota en una pestaña NUEVA y activa. Si ya está abierta en otra pestaña, activa esa (sin duplicados). Con 50 pestañas Hebra avisa y no abre nada.
- Solo el iPhone no tiene pestañas: ahí `newTab: true` equivale a `openNote(id)`.
- Sin opciones o con `{ newTab: false }` es idéntico a antes. Las claves desconocidas se ignoran, sin error.
- `activeNote()` sigue a la pestaña activa (T10): tras abrir en pestaña nueva, es la nota recién abierta.

## Novedades de la 1.5: urgencia y silencio en `notify.system` (sin publicar)

Solo se añade. `api.notify.system` admite dos campos opcionales; un Hebra anterior los ignora sin fallar.

```ts
api.notify.system({
  title: 'Botín valioso',
  body: 'Has conseguido algo',
  urgency: 'critical', // 'normal' | 'critical'
  silent: true //  el plugin toca su propio sonido
});
```

- `urgency?: 'normal' | 'critical'`: pide que el aviso salte lo que oculta los normales (p. ej. GNOME con una ventana a pantalla completa). Es una petición, no una garantía.
- `silent?: boolean`: `true` pide un aviso sin el sonido del sistema. Por defecto, sin sonido: si no lo indicas, Hebra pide `silent: true` (como antes de la 1.5); `silent: false` pide el sonido del sistema. Título y cuerpo son texto plano (se recortan a 256 y 4096 caracteres; en Linux se escapan `&`, `<` y `>`).
- `api.has('notify.urgency')` es una función del anfitrión, no un permiso: no se declara en `hebra.json`. Da `true` si ESTE Hebra lee los dos campos; en un Hebra anterior da `false`. No dice que tengan efecto en tu plataforma.
- Lo que hace cada plataforma: en **Linux funcionan los dos** (`critical` es `Urgency::Critical` y `silent` el hint `suppress-sound`, con un comando propio de Hebra sobre `notify-rust`, porque el plugin de notificaciones de Tauri no los expone). En macOS `critical` se ignora (saltar el modo concentración exige un entitlement que Hebra no tiene) y el aviso sale sin sonido propio; en Windows se ignoran los dos; iOS y Android no ofrecen `notify.system` hoy, y la web tampoco. Los valores que no son de la API se descartan.
- Host falso: `fake.api.has('notify.urgency')` da `true` y `fake.recorded.systemNotifications` guarda cada aviso aceptado con su `urgency` y `silent` (`undefined` si no los indicó).

### `api.has('instance.lock')`: ¿hay un único proceso sobre la biblioteca? (1.5, sin publicar)

Función del anfitrión, no un permiso (no se declara en `hebra.json`). Da `true` solo donde Hebra GARANTIZA que no habrá dos procesos sobre la misma base, con un candado que cruza procesos (los Web Locks de WebKitGTK no los cruzan). Es la única función del anfitrión que depende de la plataforma:

| Plataforma         | `has('instance.lock')` | Por qué                                                                                                                                                             |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (escritorio) | `true`                 | `flock` sobre `instancia.lock` en el directorio de datos, detrás del plugin de D-Bus                                                                                |
| macOS              | `false`                | hay un cerrojo parecido, pero no es una garantía: si no se puede abrir el fichero se cae a la lista de LaunchServices, y los ejecutables sin bundle no pasan por él |
| iOS, Android       | `false`                | sin candado propio                                                                                                                                                  |
| Windows            | `false`                | lo da el plugin de Tauri, no medido                                                                                                                                 |
| Web                | `false`                | no hay procesos de Hebra que cerrar                                                                                                                                 |

- `false` no dice que haya dos procesos: dice que Hebra no lo garantiza aquí. Trátalo como «no lo sé».
- Un Hebra anterior a la 1.5 no conoce el nombre y también responde `false` (falso negativo conservador): un plugin que necesita el candado debe seguir funcionando sin él.
- Host falso: `createFakePluginApi({ platform: 'linux' }).api.has('instance.lock')` da `true`; con cualquier otra plataforma (por defecto `macos`), `false`.

## Host falso

`createFakePluginApi()` imita lo que un plugin decide con ello: revisiones de nota (una `noteSave` con revisión vieja guarda una copia de conflicto y devuelve `redirected`; `notesRewriteBatch` devuelve en `stale` las de revisión vieja o que no existen, y además en `missing` las que no existen: no merece reintentarlas), la regla del título, los hosts del usuario (`confirmUserHost`, `revokeUserHost`) las fechas ISO (`setIsoDates`) y `vault.blobRead`: devuelve los bytes de un blob sembrado con `blobs: { [sha256]: bytes }` o `null` si no está, y con `remoteBlobs: { [sha256]: bytes }` siembra blobs «solo remotos» que la primera lectura «baja» (queda anotado en `recorded.remoteBlobDownloads`) para probar la bajada bajo demanda.

Como el registro de Hebra, lanza si el id sigue registrado en `ui.registerView` (también entre colocaciones `'column'`, `'dialog'` y `'main'`), `ui.registerCommand`, `ui.registerStatusBarItem` y `editor.registerCodeBlock` (el lenguaje se compara recortado y en minúsculas); tras desregistrar, el id vuelve a valer. `ribbon`, `ribbonItem`, `settingsPanel` y `registerExtension` admiten repetidos, como en Hebra. Diferencia: Hebra comparte los ids entre plugins; el falso solo conoce al que pruebas.

Los métodos `noteTrashIfUnchanged` y `noteMoveIfUnchanged` reciben la revisión y carpeta observadas; `noteRestoreIfUnchanged`, la revisión y fecha de papelera. Devuelven la nota confirmada o `null` sin efectos si cambió o está protegida. `folderRenameIfUnchanged` y `folderMoveIfUnchanged` comparan nombre y padre y devuelven la carpeta confirmada o `null`. Todos requieren `vault.write`. `noteRestore` conserva su resultado booleano.

`notesRewriteBatch` conserva `written` y `stale` y añade `committed: {id, body, revision}[]`, capturado dentro de la misma transacción. `body` es el texto guardado, incluido el orden de tareas que aplique Hebra, y `revision` corresponde a ese texto.

Para deshacer texto, cada entrada de `notesRewriteBatch` puede pedir `strictRevision: true`: exige secuencia **y** hash, incluidos los cambios externos que guardan el mismo texto. Sin esa bandera conserva la comparación histórica por secuencia **o** hash.

# hebra-plugin-api

API pública de los plugins de Hebra, versión `1.0.0` (`docs/SPEC-PLUGINS-EXTERNOS.md` §5 y §6 del repo de Hebra).

Este paquete vive en el repo de Hebra (`packages/plugin-api/`) y es la fuente de los tipos: la fachada de Hebra (`src/lib/plugins/api/create-plugin-api.ts`) se compila contra ellos. Se publica copiándolo al repo público `fodaveg/hebra-plugin-api`, con una etiqueta `vX.Y.Z` por versión de API (§5.4), con `node scripts/plugin-api-publish.mjs --out <dir>` desde el repo de Hebra. Ese script falla si la versión de `package.json` no es la que implementa Hebra, y añade `dist/` (el mismo código en JavaScript) para que Node pueda importar `hebra-plugin-api/build` desde el script de build de un plugin: Node no quita tipos de un `.ts` dentro de `node_modules`. Un plugin lo instala como dependencia de desarrollo: `npm install -D github:fodaveg/hebra-plugin-api#v1.0.0`.

## Qué trae

| Entrada                    | Qué es                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hebra-plugin-api`         | Tipos (`HebraPluginApi`, `HebraPluginModule` y cada fachada), `PLUGIN_CAPABILITIES`, `PLUGIN_API_ERROR_CODES` e `isPluginApiError(error, code?)`.                             |
| `hebra-plugin-api/shared`  | La lista de módulos que presta Hebra (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/common`, `@lezer/highlight`) y la clave de su registro global. |
| `hebra-plugin-api/build`   | `hebraShared()` para esbuild y `hebraSharedRollup()` para Rollup, Rolldown y Vite: cada import de un módulo prestado lee el de Hebra en vez de empaquetar otra copia.         |
| `hebra-plugin-api/testing` | `createFakePluginApi(options)`: una API en memoria para probar un plugin sin Hebra.                                                                                           |

Los tipos son TypeScript sin compilar (`src/`); el código que importa Node o empaqueta esbuild sale de `dist/` en el paquete publicado.

## Un plugin mínimo

La plantilla está en `template/`: `hebra.json`, `src/main.ts` y su `tsconfig.json`. El módulo exporta `activate(api)`:

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

`ui`, `env`, `storage`, `markdown` y `workspace` están siempre. Un `hebra.json` que declare `workspace` sigue siendo válido: Hebra lo acepta y lo ignora. El resto (`vault.read`, `vault.write`, `editor`, `http`, `secrets`, `tcp`, `notify.system`, `background`) se declara en `hebra.json`; sin declarar, cada método rechaza con `capability-not-declared`. Una capacidad declarada que la plataforma no tiene (TCP en iPhone) rechaza con `unavailable-on-platform`. `api.has(capacidad)` dice si se puede usar aquí. En la versión 1.0.0 de Hebra, `secrets` rechaza con `capability-not-available` y `http` solo llega a los hosts que Hebra ya permite en Rust (y en la web todavía no existe).

Los errores se reconocen con `isPluginApiError(error, 'host-not-declared')`, nunca con `instanceof`.

## Títulos de nota

El título lo deriva Hebra del cuerpo: la propiedad `title:` del frontmatter o, si no hay, el primer `# …`. `vault.noteCreate` toma el que dé el cuerpo; `vault.noteSave` y `vault.notesRewriteBatch` también (cambiar el `# …` cambia el título), y solo conservan un título que no salía del cuerpo (el nombre de fichero de una nota importada sin título) si el cuerpo nuevo no da ninguno. Para fijar el título sin tocar el encabezado: `api.markdown.withTitle(body, 'Título')`, que escribe `title: "Título"` en el frontmatter en el mismo formato que Hebra. `api.markdown.frontmatterRange(body)` da `{ start, end }` del bloque de frontmatter (`end` justo después del `---` de cierre y su salto de línea) o `null`.

## Servidores que elige el usuario

Un plugin que habla con un servidor que no se sabe al publicarlo (un webhook, un servidor propio) declara `"network": { "hosts": [...], "userHosts": true }` y, antes de llamarlo, pide permiso:

```ts
if (await api.http.requestUserHost('https://hooks.ejemplo.com/abc')) {
  await api.http.request({ url: 'https://hooks.ejemplo.com/abc', method: 'POST', body });
}
```

La primera vez Hebra pregunta al usuario («Permitir» / «No permitir»); el sí se recuerda para ese plugin en ese dispositivo (no se sincroniza) y se puede quitar en Ajustes › Plugins. Solo `https:`, host exacto, sin comodines ni IP. Sin `userHosts: true`, `requestUserHost` rechaza con `host-not-declared`; en la web rechaza con `unavailable-on-platform` hasta que exista el relé de Hebra.

## Entorno

`api.env.platform` dice qué build de Hebra corre (`'ios'` en la app de iPhone y iPad, `'web'` en el navegador). `api.env.appleMobile()` dice si el dispositivo es un iPhone o un iPad, también en la web. `api.env.isoDates()` y `api.env.onIsoDatesChange(listener)` leen el ajuste «Usar fechas ISO 8601» de Hebra. `api.vault.rootFolderId()` es el id de la carpeta raíz.

## Host falso

`createFakePluginApi()` imita lo que un plugin decide con ello: revisiones de nota (una `noteSave` con revisión vieja guarda una copia de conflicto y devuelve `redirected`; `notesRewriteBatch` devuelve en `stale` las de revisión vieja o que no existen), la regla del título, los hosts del usuario (`confirmUserHost`, `revokeUserHost`) y las fechas ISO (`setIsoDates`).

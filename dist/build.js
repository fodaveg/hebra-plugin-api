/**
 * `hebraShared()`: el plugin de build que hace que un plugin USE el CodeMirror de Hebra
 * en vez de empaquetar el suyo (`docs/SPEC-PLUGINS-EXTERNOS.md` §6). Cada import de un
 * módulo de `PLUGIN_SHARED_MODULES` (también los de dependencias transitivas del
 * plugin) se resuelve a un módulo virtual que lee del registro que publica Hebra
 * (`sharedModuleSource`). Los nombres exportados se leen del paquete REAL instalado en
 * el repo del plugin, en el momento del build.
 *
 * Dos formas del mismo plugin, sin depender de ninguna de las dos herramientas:
 * - `hebraShared()` para esbuild (la que usan los repos de Tyrian y JDex, §11.3);
 * - `hebraSharedRollup()` para Rollup, Rolldown y Vite (la que usa el test de Hebra).
 *
 * Versiones de esbuild soportadas: `>=0.17.0 <1.0.0`. Solo usa `onResolve`/`onLoad` con
 * `filter` y `namespace` y `loader: 'js'`, que existen igual en todo ese rango. Probados
 * los dos extremos: 0.17.3 (la de la plantilla de plugins de Obsidian, que usa JDex) y
 * 0.28.2 (la más reciente el 3 oct 2026), con `node scripts/plugin-api-esbuild-compat.mjs`
 * del repo de Hebra, que compila `template/` con el paquete PUBLICADO
 * (`scripts/plugin-api-publish.mjs`).
 *
 * Sin imports compartidos (`"shared": {}` en `hebra.json`) los dos no hacen nada: el
 * filtro no casa con ningún import y la salida es la misma que sin el plugin.
 *
 * Solo para el build del plugin (Node): nunca se importa desde Hebra en ejecución. En el
 * paquete publicado lo importa Node desde `dist/build.js` (Node no quita tipos de un
 * `.ts` dentro de `node_modules`); los tipos siguen saliendo de este fichero.
 */
import { isPluginSharedModule, PLUGIN_SHARED_MODULES, sharedModuleSource } from './shared.js';
const NAMESPACE = 'hebra-shared';
const VIRTUAL_PREFIX = '\0hebra-shared:';
async function exportNamesOf(specifier, options) {
    const fixed = options.exportNames?.[specifier];
    if (fixed)
        return fixed;
    const namespace = (await import(specifier));
    return Object.keys(namespace);
}
/**
 * Los filtros de esbuild son expresiones de Go (RE2), y SIN banderas a propósito: desde
 * alguna versión entre la 0.17.3 y la 0.28.2, esbuild traduce las banderas de la RegExp a
 * Go y `u` sale como `(?u)`, que Go no admite («"onResolve" filter is not a valid Go
 * regular expression», medido con 0.28.2 el 3 oct 2026; la 0.17.3 las ignoraba).
 */
const SHARED_FILTER = new RegExp(`^(${PLUGIN_SHARED_MODULES.map((name) => name.replace(/[/.]/gu, '\\$&')).join('|')})$`);
const ANY_PATH = /.*/;
/** Plugin de esbuild (§6). */
export function hebraShared(options = {}) {
    return {
        name: 'hebra-shared',
        setup(build) {
            build.onResolve({ filter: SHARED_FILTER }, (args) => isPluginSharedModule(args.path) ? { path: args.path, namespace: NAMESPACE } : undefined);
            build.onLoad({ filter: ANY_PATH, namespace: NAMESPACE }, async (args) => {
                const specifier = args.path;
                return {
                    contents: sharedModuleSource(specifier, await exportNamesOf(specifier, options)),
                    loader: 'js'
                };
            });
        }
    };
}
/** El mismo plugin con los ganchos de Rollup (`resolveId`/`load`), que entienden también
 *  Rolldown y Vite. */
export function hebraSharedRollup(options = {}) {
    return {
        name: 'hebra-shared',
        enforce: 'pre',
        resolveId(source) {
            return isPluginSharedModule(source) ? `${VIRTUAL_PREFIX}${source}` : null;
        },
        async load(id) {
            if (!id.startsWith(VIRTUAL_PREFIX))
                return null;
            const specifier = id.slice(VIRTUAL_PREFIX.length);
            if (!isPluginSharedModule(specifier))
                return null;
            return sharedModuleSource(specifier, await exportNamesOf(specifier, options));
        }
    };
}

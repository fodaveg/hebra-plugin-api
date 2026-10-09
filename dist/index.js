/** Versión de la API que describen estos tipos (la del paquete). */
export const PLUGIN_API_VERSION = '1.3.0';
// ---- Plataforma y capacidades (§5.3, §7) ----
export const PLUGIN_PLATFORMS = ['macos', 'ios', 'linux', 'windows', 'android', 'web'];
/**
 * Lo que un plugin declara en `hebra.json` (`capabilities.required`/`optional`) y lo que
 * pregunta `api.has()`. `ui`, `env`, `storage`, `markdown` y `workspace` están SIEMPRE.
 * `workspace` sigue en esta lista solo para que `api.has('workspace')` compile (y dé
 * `true`) y para que un `hebra.json` que lo declare siga siendo válido: Hebra lo acepta y
 * lo ignora, no hace falta declararlo. El resto, sin declarar, rechaza con
 * `capability-not-declared`.
 */
export const PLUGIN_CAPABILITIES = [
    'vault.read',
    'vault.write',
    'workspace',
    'editor',
    'http',
    'secrets',
    'tcp',
    'notify.system',
    'background'
];
/**
 * Desde la 1.3. Lo que el ANFITRIÓN sabe hacer, que también se pregunta con `api.has()`.
 * No son permisos: no se declaran en `hebra.json` (un Hebra anterior daría por incompatible
 * un plugin que las pusiera en `capabilities.required`) y no salen en la hoja de
 * consentimiento. Un Hebra que no conoce un nombre responde `false` sin lanzar, así que
 * `api.has('ui.view.main')` es la forma de degradar sin comparar versiones.
 *
 * - `ui.view.main`: `placement: 'main'`, `ui.updateView`, `ui.updateViewSection` y la
 *   opción `section` de `ui.revealView` (`PluginMainViewDefinition`).
 */
export const PLUGIN_HOST_FEATURES = ['ui.view.main'];
// ---- Errores ----
/**
 * Códigos con los que rechaza (o lanza) la API. Un plugin los distingue con
 * `isPluginApiError(error, code)`, nunca con `instanceof`: la clase vive en el paquete
 * de Hebra, no en el del plugin.
 *
 * - `capability-not-declared`: el plugin no la puso en `hebra.json`.
 * - `unavailable-on-platform`: declarada, pero esta plataforma no la tiene (TCP en
 *   iPhone, §7). No se llega a invocar nada nativo.
 * - `capability-not-available`: declarada, pero esta versión de Hebra todavía no la
 *   implementa en ninguna plataforma (hoy, ninguna).
 * - `host-not-declared`: `http.request` a un host que no está en `network.hosts` ni lo
 *   ha aceptado el usuario (`http.requestUserHost`), o `requestUserHost` sin
 *   `network.userHosts: true` en `hebra.json` (§8.4).
 * - `extension-rechazada`: la extensión de CodeMirror no se puede montar (otra copia de
 *   `@codemirror/state`, valor que no es extensión, §6).
 * - `note-locked`: escritura sobre una nota protegida (§8.5): nunca se toca.
 * - `invalid-argument`: argumento con forma inválida (URL, id vacío…).
 * - `plugin-disposed`: llamada a un registro después de apagar el plugin.
 */
export const PLUGIN_API_ERROR_CODES = [
    'capability-not-declared',
    'unavailable-on-platform',
    'capability-not-available',
    'host-not-declared',
    'extension-rechazada',
    'note-locked',
    'invalid-argument',
    'plugin-disposed'
];
/** `true` si `error` es un error de la API (y, con `code`, de ese código). */
export function isPluginApiError(error, code) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    if (candidate.name !== 'PluginApiError')
        return false;
    if (!PLUGIN_API_ERROR_CODES.includes(candidate.code))
        return false;
    return code === undefined || candidate.code === code;
}

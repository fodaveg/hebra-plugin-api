/** Versión de la API que describen estos tipos (la del paquete). */
export const PLUGIN_API_VERSION = '1.7.0';
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
 * - `markdown.image.remote` (desde la 1.4): una imagen Markdown con destino `https`,
 *   `![alt](https://…)`, se pinta EN LÍNEA en la nota, también en una línea de lista y en
 *   una celda de tabla. Tamaño con la sintaxis de Obsidian, `![alt|24](…)` (ancho en px)
 *   o `![alt|24x24](…)`; dentro de una tabla la barra va escapada, `![alt\|24](…)`. Un
 *   Hebra anterior enseña el texto alternativo (con el `|24` a la vista) en vez de la
 *   imagen, así que un plugin que escribe iconos en las notas pregunta antes. El usuario
 *   puede apagar la carga («Cargar imágenes remotas»): `has()` sigue dando `true` y la
 *   nota enseña el alternativo, ya sin el `|24`.
 * - `notify.urgency` (desde la 1.5): este Hebra ACEPTA `urgency` y `silent` en
 *   `notify.system` (`PluginSystemNotifyInput`). Dice que los campos se leen, no que
 *   tengan efecto en cada plataforma (ver el JSDoc de `urgency` y `silent`); un Hebra
 *   anterior los ignora sin fallar.
 * - `instance.lock` (desde la 1.5): este Hebra GARANTIZA un único proceso sobre la misma
 *   biblioteca, con un candado de instancia que cruza procesos. Es la ÚNICA función del
 *   anfitrión que depende de la plataforma: hoy `true` solo en Linux de escritorio
 *   (`flock` sobre `instancia.lock` en el directorio de datos); `false` en macOS, iOS,
 *   Windows, Android y la web. Sirve a un plugin que coordina trabajo entre procesos y no
 *   puede fiarse de los Web Locks de WebKitGTK (no cruzan procesos). `false` NO dice que
 *   haya dos procesos, dice que Hebra no lo garantiza aquí. Un Hebra anterior a la 1.5
 *   no conoce el nombre y también responde `false`: es un falso negativo conservador.
 * - `ui.view.tab` (desde la 1.7): `placement: 'tab'` (`PluginTabViewDefinition`) y
 *   `workspace.openView`: una vista del plugin como contenido de una pestaña de la columna
 *   de contenido. `true` en todas las plataformas (donde no hay tira de pestañas, como el
 *   iPhone, la vista ocupa la pestaña única); un Hebra anterior responde `false`.
 */
export const PLUGIN_HOST_FEATURES = [
    'ui.view.main',
    'markdown.image.remote',
    'notify.urgency',
    'instance.lock',
    'ui.view.tab'
];
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
/** Desde la 1.7. Tope del estado de UNA pestaña: bytes UTF-8 de su `JSON.stringify`. */
export const PLUGIN_TAB_VIEW_STATE_MAX_BYTES = 8192;
/** Desde la 1.7. Tope de la clave de una pestaña y de su título, en caracteres. */
export const PLUGIN_TAB_VIEW_TEXT_MAX_LENGTH = 200;

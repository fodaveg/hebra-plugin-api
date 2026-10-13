/**
 * Errores por el puerto de la 2.0 (lote L4 del plan C1; spec §5.5.3): cómo cruza un error y
 * cómo se rehace al otro lado. Lo usan los dos extremos, el marco (`./frame-api.ts`) y Hebra
 * (`./host-dispatch.ts`, `src/lib/plugins/frame/plugin-frame-host.ts`). Código de Hebra.
 */
import { isPluginApiError } from './index.js';
/** Texto de un error que cruza el puerto: nunca más largo que esto. */
export const PLUGIN_FRAME_ERROR_TEXT_LIMIT = 500;
/** Corta sin partir un par sustituto (el puerto lo admitiría; la consola, mal). */
export function clipFrameText(value, limit = PLUGIN_FRAME_ERROR_TEXT_LIMIT) {
    const text = String(value ?? '');
    if (text.length <= limit)
        return text;
    const code = text.charCodeAt(limit - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}
/**
 * Un error tal como cruza el puerto: el de la API con su código y su texto; cualquier otro,
 * con su nombre y su texto acotados (nunca el objeto, que podría no clonarse o llevar datos).
 */
export function serializeFrameError(error) {
    if (isPluginApiError(error)) {
        return { name: 'PluginApiError', code: error.code, message: clipFrameText(error.message) };
    }
    const named = typeof error === 'object' && error !== null
        ? error
        : null;
    const name = named && typeof named.name === 'string' && named.name !== '' && named.name !== 'PluginApiError'
        ? clipFrameText(named.name, 100)
        : 'Error';
    const message = named && 'message' in named ? clipFrameText(named.message) : clipFrameText(error);
    return { name, message };
}
/**
 * Un error del puerto, ya al otro lado: un `Error` de ESTE realm (con su pila) con el nombre,
 * el texto y, si es de la API, el código. `isPluginApiError`/`api.isError` lo reconocen.
 */
export function frameError(shape) {
    // Llega por el puerto: no se da nada por supuesto de su forma.
    const raw = (typeof shape === 'object' && shape !== null ? shape : {});
    const error = new Error(clipFrameText(raw.message));
    error.name =
        typeof raw.name === 'string' && raw.name !== '' ? clipFrameText(raw.name, 100) : 'Error';
    if (raw.name === 'PluginApiError' && typeof raw.code === 'string') {
        error.code = raw.code;
    }
    return error;
}
/** Un error de la API creado sin preguntar al otro lado (lo que respondería). */
export function frameApiError(code, message) {
    return frameError({ name: 'PluginApiError', code, message });
}

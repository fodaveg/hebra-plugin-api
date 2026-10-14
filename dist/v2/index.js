/** La versión de la API que describe esta entrada (la de Hebra: `HEBRA_PLUGIN_API_VERSION_V2`). */
export const PLUGIN_API_VERSION = '2.2.0';
/** Los códigos de `PluginApiErrorCode`, como valor (los comprueba `isPluginApiError`). */
export const PLUGIN_API_ERROR_CODES = [
    'capability-not-declared',
    'unavailable-on-platform',
    'capability-not-available',
    'host-not-declared',
    'note-locked',
    'invalid-argument',
    'plugin-disposed',
    'user-activation-required',
    'quota-exceeded'
];
const _everyErrorCode = true;
void _everyErrorCode;
/**
 * `true` si `error` es un error de la API 2.0 (y, con `code`, de ese código). Es lo mismo que
 * `api.isError`; sirve donde no hay `api` a mano (un test, un módulo que no la recibe).
 */
export function isPluginApiError(error, code) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    if (candidate.name !== 'PluginApiError' || typeof candidate.message !== 'string')
        return false;
    if (!PLUGIN_API_ERROR_CODES.includes(candidate.code))
        return false;
    return code === undefined || candidate.code === code;
}

/** Tope del estado de una pestaña: bytes UTF-8 de su `JSON.stringify`
 *  (`PLUGIN_TAB_VIEW_STATE_MAX_BYTES`). */
export const TAB_VIEW_STATE_MAX_BYTES = 8192;
/** Tope de la clave y del título de una pestaña, en caracteres
 *  (`PLUGIN_TAB_VIEW_TEXT_MAX_LENGTH`). */
export const TAB_VIEW_TEXT_MAX_LENGTH = 200;
/** Más anidado que esto no es un estado razonable (y corta los ciclos sin recorrerlos). */
const MAX_DEPTH = 64;
function isPlainObject(value) {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/** El primer sitio donde `value` deja de ser JSON, o `null` si lo es entero. */
function jsonProblem(value, depth) {
    if (depth > MAX_DEPTH)
        return `anida más de ${MAX_DEPTH} niveles`;
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return null;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? null : 'lleva un número que no es finito';
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const problem = jsonProblem(item, depth + 1);
            if (problem)
                return problem;
        }
        return null;
    }
    if (typeof value === 'object' && isPlainObject(value)) {
        for (const item of Object.values(value)) {
            const problem = jsonProblem(item, depth + 1);
            if (problem)
                return problem;
        }
        return null;
    }
    return `lleva un valor que no es JSON (${typeof value === 'object' ? 'objeto no plano' : typeof value})`;
}
/** Bytes UTF-8 del estado ya serializado. */
export function tabViewStateBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
}
/**
 * Por qué ese estado no vale (no es JSON o pasa del tope), o `null` si vale. `null` y
 * `undefined` valen: «sin estado».
 */
export function tabViewStateProblem(value) {
    if (value === undefined || value === null)
        return null;
    const problem = jsonProblem(value, 0);
    if (problem)
        return `el estado ${problem}`;
    const bytes = tabViewStateBytes(value);
    return bytes > TAB_VIEW_STATE_MAX_BYTES
        ? `el estado ocupa ${bytes} bytes y el tope es ${TAB_VIEW_STATE_MAX_BYTES}`
        : null;
}
/**
 * Una copia propia del estado (ya validado con `tabViewStateProblem`): ni el plugin cambia
 * por la espalda lo guardado ni recibe una referencia a lo de otra pestaña. `undefined`,
 * `null`.
 */
export function cloneTabViewState(value) {
    return value === undefined || value === null
        ? null
        : JSON.parse(JSON.stringify(value));
}
/** Por qué esa clave no vale, o `null`. Sin clave (`undefined`) vale: es `''`. */
export function tabViewKeyProblem(key) {
    if (key === undefined)
        return null;
    if (typeof key !== 'string')
        return 'la clave tiene que ser un texto';
    return key.length > TAB_VIEW_TEXT_MAX_LENGTH
        ? `la clave pasa de ${TAB_VIEW_TEXT_MAX_LENGTH} caracteres`
        : null;
}
/** Por qué ese título no vale, o `null`. `undefined`, `null` y `''` valen («el de la vista»). */
export function tabViewTitleProblem(title) {
    if (title === undefined || title === null)
        return null;
    if (typeof title !== 'string')
        return 'el título tiene que ser un texto';
    return title.trim().length > TAB_VIEW_TEXT_MAX_LENGTH
        ? `el título pasa de ${TAB_VIEW_TEXT_MAX_LENGTH} caracteres`
        : null;
}
/** El título propio de una pestaña, o `null` si debe usar el de la vista (vacío o ausente). */
export function tabViewOwnTitle(title) {
    const trimmed = title?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
}

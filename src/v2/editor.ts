/**
 * Límites y comprobaciones del editor declarativo de la API 2.0 (lote L6 del plan C1; spec
 * §6.1 y §8.5).
 *
 * Es código de HEBRA, no del plugin: lo usan el editor de Hebra (`src/lib/editor/
 * plugin-declarative-editor.ts`, en su realm) y el host falso (`./testing.ts`), para que las dos
 * partes den el mismo veredicto sobre lo que un proveedor devuelve.
 *
 * Lo que un proveedor devuelve llega del marco del plugin por el puerto: NO es de fiar (el
 * plugin puede escribir en el puerto lo que quiera). Aquí se descarta en silencio todo lo que no
 * cumple el contrato, sin lanzar: una decoración mala no tumba las demás ni el editor.
 */
import type {
  PluginCompletionOption,
  PluginCompletionResult,
  PluginDecoration,
  PluginDecorationStyle
} from './index';

/**
 * Los topes del editor declarativo. Los de tiempo salen de medir el recorrido completo
 * (Hebra → puerto → marco → proveedor → puerto → Hebra) y están en el plan C1 §6 L6; los de
 * cantidad y tamaño, del contrato (spec §6.1).
 */
export const PLUGIN_EDITOR_LIMITS = Object.freeze({
  /** Una respuesta de decoraciones que tarda más no se pinta; lo anterior sigue. */
  decorationsTimeoutMs: 300,
  /** Una lista de sugerencias que tarda más no se enseña. */
  completionTimeoutMs: 250,
  /** Espera tras el último cambio del texto o del viewport antes de pedir decoraciones. */
  decorationsDebounceMs: 80,
  /** Decoraciones por respuesta; el resto se descarta. */
  maxDecorations: 1000,
  /** Sugerencias por respuesta; el resto se descarta. */
  maxCompletionOptions: 50,
  /** Caracteres de margen por arriba y por abajo del trozo que se ve, al pedir decoraciones. */
  decorationsMarginChars: 2000,
  /** Tope del texto de una petición de decoraciones (UTF-16). */
  maxRequestChars: 100_000,
  /** Tope de la línea que se manda al pedir sugerencias (UTF-16). */
  maxLineChars: 10_000,
  /** Fallos seguidos de un proveedor tras los cuales Hebra deja de llamarlo. */
  maxConsecutiveFailures: 3,
  /** Elementos de una respuesta que se miran como mucho (un array de basura no cuesta más). */
  maxInspectedDecorations: 5000,
  maxInspectedOptions: 500,
  /** Margen sobre el tope de tiempo tras el cual el canal purga la espera de un `provide`. */
  channelGraceMs: 50,
  maxIdChars: 120,
  maxTitleChars: 200,
  maxDataChars: 256,
  maxLabelChars: 200,
  maxDetailChars: 200,
  maxApplyChars: 1000,
  maxTriggers: 16
});

export const PLUGIN_DECORATION_STYLES = [
  'link',
  'accent',
  'muted',
  'warning',
  'danger'
] as const satisfies readonly PluginDecorationStyle[];

export function isDecorationStyle(value: unknown): value is PluginDecorationStyle {
  return (PLUGIN_DECORATION_STYLES as readonly unknown[]).includes(value);
}

/** La clase CSS que Hebra pone a un rango decorado. Fija: la hoja del plugin no llega al editor. */
export function decorationClass(style: PluginDecorationStyle, clickable: boolean): string {
  return `hebra-plugin-decoration hebra-plugin-decoration-${style}${
    clickable ? ' hebra-plugin-decoration-clickable' : ''
  }`;
}

/** Corta a `max` unidades UTF-16 sin dejar medio par subrogado al final. */
export function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Las decoraciones válidas de una respuesta. `window` es el trozo que se pidió
 * (`offset` y `length` del texto): un rango fuera de él, vacío, invertido o con un estilo que no
 * es del juego fijo se descarta, y se queda en `maxDecorations`. El resultado va ordenado por
 * `from`.
 */
export function sanitizeDecorations(
  raw: unknown,
  window: { readonly offset: number; readonly length: number }
): PluginDecoration[] {
  if (!Array.isArray(raw)) return [];
  const end = window.offset + window.length;
  const out: PluginDecoration[] = [];
  const inspected = Math.min(raw.length, PLUGIN_EDITOR_LIMITS.maxInspectedDecorations);
  for (let index = 0; index < inspected; index += 1) {
    if (out.length >= PLUGIN_EDITOR_LIMITS.maxDecorations) break;
    const item: unknown = raw[index];
    if (!isRecord(item)) continue;
    const { from, to, style } = item;
    if (!isIndex(from) || !isIndex(to) || !(from < to)) continue;
    if (from < window.offset || to > end) continue;
    if (!isDecorationStyle(style)) continue;
    const decoration: PluginDecoration = { from, to, style };
    if (typeof item.title === 'string' && item.title !== '') {
      decoration.title = clipText(item.title, PLUGIN_EDITOR_LIMITS.maxTitleChars);
    }
    if (item.clickable === true) {
      decoration.clickable = true;
      if (item.clickModifier === 'mod') decoration.clickModifier = 'mod';
      if (typeof item.data === 'string') {
        decoration.data = clipText(item.data, PLUGIN_EDITOR_LIMITS.maxDataChars);
      }
    }
    out.push(decoration);
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * Las sugerencias válidas de una respuesta. `from` tiene que caer en la línea del cursor y no
 * pasar del cursor; `to`, entre `from` y el final de la línea (sin él, el cursor). Sin ninguna
 * opción válida, `null` (no hay nada que enseñar).
 */
export function sanitizeCompletion(
  raw: unknown,
  at: { readonly lineFrom: number; readonly lineLength: number; readonly pos: number }
): PluginCompletionResult | null {
  if (!isRecord(raw) || !Array.isArray(raw.options)) return null;
  const lineEnd = at.lineFrom + at.lineLength;
  const { from } = raw;
  if (!isIndex(from) || from < at.lineFrom || from > at.pos) return null;
  let to = at.pos;
  if (raw.to !== undefined && raw.to !== null) {
    if (!isIndex(raw.to) || raw.to < from || raw.to > lineEnd) return null;
    to = raw.to;
  }
  const options: PluginCompletionOption[] = [];
  const inspected = Math.min(raw.options.length, PLUGIN_EDITOR_LIMITS.maxInspectedOptions);
  for (let index = 0; index < inspected; index += 1) {
    if (options.length >= PLUGIN_EDITOR_LIMITS.maxCompletionOptions) break;
    const item: unknown = raw.options[index];
    if (!isRecord(item) || typeof item.label !== 'string' || item.label === '') continue;
    const option: PluginCompletionOption = {
      label: clipText(item.label, PLUGIN_EDITOR_LIMITS.maxLabelChars)
    };
    if (typeof item.detail === 'string' && item.detail !== '') {
      option.detail = clipText(item.detail, PLUGIN_EDITOR_LIMITS.maxDetailChars);
    }
    if (typeof item.apply === 'string') {
      option.apply = clipText(item.apply, PLUGIN_EDITOR_LIMITS.maxApplyChars);
    }
    options.push(option);
  }
  if (options.length === 0) return null;
  return { from, to, options };
}

/** Los disparadores válidos de un proveedor: caracteres sueltos, sin repetir, hasta el tope. */
export function sanitizeTriggers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= PLUGIN_EDITOR_LIMITS.maxTriggers) break;
    if (typeof item !== 'string' || item === '' || [...item].length !== 1) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

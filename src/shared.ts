/**
 * Módulos que Hebra PRESTA a los plugins (`docs/SPEC-PLUGINS-EXTERNOS.md` §6): la MISMA
 * instancia que usa su editor, para que una extensión de CodeMirror creada por un plugin
 * la reconozca su `EditorState` (dos copias de `@codemirror/state` dan «Unrecognized
 * extension value… multiple instances»).
 *
 * Cómo: Hebra publica antes de cargar ningún plugin un registro en
 * `globalThis[Symbol.for(PLUGIN_SHARED_GLOBAL_KEY)]`; al compilar el plugin,
 * `hebraShared()` (`./build`) sustituye cada import de estos módulos por un módulo
 * virtual que lee de ese registro (`sharedModuleSource`). Sin estado y sin dependencias:
 * lo usan Hebra (al publicar) y el build del plugin (al leer).
 *
 * Añadir un módulo a la lista es una versión MENOR de la API; quitarlo, MAYOR (§5.4).
 */

/** Clave del registro global (con `Symbol.for`, para que plugin y Hebra den el mismo). */
export const PLUGIN_SHARED_GLOBAL_KEY = 'hebra.plugin-shared.v1';

/** Lista v1 (§6). `@codemirror/autocomplete` NO está: Hebra no lo tiene directo. */
export const PLUGIN_SHARED_MODULES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@lezer/common',
  '@lezer/highlight'
] as const;
export type PluginSharedModule = (typeof PLUGIN_SHARED_MODULES)[number];

/** Una entrada del registro: la versión instalada en Hebra y el espacio de nombres. */
export interface PluginSharedModuleEntry {
  readonly version: string;
  readonly namespace: Readonly<Record<string, unknown>>;
}

export interface PluginSharedRegistry {
  readonly modules: Readonly<Partial<Record<PluginSharedModule, PluginSharedModuleEntry>>>;
}

export function isPluginSharedModule(specifier: string): specifier is PluginSharedModule {
  return (PLUGIN_SHARED_MODULES as readonly string[]).includes(specifier);
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * El código del módulo virtual que sustituye a `import … from '<specifier>'` dentro del
 * plugin: lee el espacio de nombres del registro y reexporta `exportNames` (los del
 * paquete real, leídos en el build). Si Hebra no presta ese módulo, lanza al evaluarse
 * con un mensaje que lo dice, en vez de fallar más tarde con un `undefined`.
 */
export function sharedModuleSource(
  specifier: PluginSharedModule,
  exportNames: readonly string[]
): string {
  const names = [...new Set(exportNames)].filter(
    (name) => name !== 'default' && IDENTIFIER.test(name)
  );
  const key = JSON.stringify(PLUGIN_SHARED_GLOBAL_KEY);
  const spec = JSON.stringify(specifier);
  const lines = [
    `const registry = globalThis[Symbol.for(${key})];`,
    `const entry = registry && registry.modules ? registry.modules[${spec}] : undefined;`,
    `if (!entry) throw new Error(${JSON.stringify(
      `Hebra no presta «${specifier}» a los plugins (¿versión de Hebra antigua?).`
    )});`,
    `const m = entry.namespace;`,
    ...names.map((name) => `export const ${name} = m.${name};`)
  ];
  return `${lines.join('\n')}\n`;
}
